"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import {
  acquireLock,
  buildDefaultSigners,
  createDocument,
  isEditable,
  isStaffRole,
  isTerminal,
  loadSigners,
  releaseLock,
  replaceSigners,
  signersDueNow,
  voidDocument,
  type SignerInput,
} from "@/lib/esign/documents";
import { resolveContextAppointment } from "@/lib/esign/fields";
import { sendDocument, afterSignature, sendAllPendingForPatient } from "@/lib/esign/flow";
import { recordSignature, declineDocument, saveStaffSignature } from "@/lib/esign/signing";
import { revokeSignerTokens, issueSigningToken } from "@/lib/esign/tokens";
import {
  deliverToSigner,
  loadClinicDelivery,
  notifyStaffOfSignerAction,
} from "@/lib/esign/delivery";
import { autoSignStaff } from "@/lib/esign/auto-sign";
import { logDocEvent } from "@/lib/esign/events";
import { emitDocumentTrigger } from "@/lib/esign/jobs";

/**
 * Everything staff can do to a document.
 *
 * Two invariants run through the whole file. A document is writable only while
 * it is a draft — once frozen, the only permitted changes are signatures and the
 * terminal transitions. And doctors cannot create or send: they are signers, and
 * the role split in this product already says so everywhere else.
 */

const bad = (error: string) => ({ error });

async function requestMeta() {
  const h = await headers();
  const chain = h.get("x-forwarded-for");
  const ip = chain
    ? chain.split(",").map((p) => p.trim()).filter(Boolean).slice(-1)[0]
    : h.get("x-real-ip");
  return { ip: ip || null, userAgent: h.get("user-agent") };
}

// ------------------------------------------------------------------- create

const signerInputSchema = z.object({
  roleKey: z.string().trim().min(1).max(40),
  order: z.coerce.number().int().min(0).max(20).optional(),
  required: z.boolean().optional(),
  displayName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  relationship: z.string().trim().max(60).nullable().optional(),
});

const createSchema = z.object({
  templateId: z.string().uuid(),
  patientId: z.string().uuid().nullable().optional(),
  appointmentId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  language: z.enum(["ar", "en"]).optional(),
  signers: z.array(signerInputSchema).max(10).optional(),
});

export async function createDocumentAction(
  slug: string,
  input: unknown
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return bad("invalid");
  const d = parsed.data;

  return inClinic(access, async (c) => {
    const template = (
      await c.query(
        `select id, name, name_ar, language, signer_config, source, source_pdf_path
         from document_templates where id = $1 and clinic_id = $2 and is_active`,
        [d.templateId, access.clinicId]
      )
    ).rows[0];
    if (!template) return bad("not_found");

    const patient = d.patientId
      ? (
          await c.query(
            `select id, full_name, phone_e164, birth_date from patients
             where id = $1 and clinic_id = $2 and merged_into is null`,
            [d.patientId, access.clinicId]
          )
        ).rows[0]
      : null;
    if (d.patientId && !patient) return bad("not_found");

    let language: "ar" | "en" =
      d.language ?? (access.clinic.defaultLocale === "en" ? "en" : "ar");
    if (template.language === "ar") language = "ar";
    if (template.language === "en") language = "en";

    /*
      A document raised from the patient's file is about a visit, even though
      nobody named one — that is where the doctor, the service and the price come
      from. Resolve it here rather than at merge time so the document records
      which appointment its values came from.
    */
    const appointmentId =
      d.appointmentId ??
      (d.patientId ? await resolveContextAppointment(c, access.clinicId, d.patientId) : null);

    const signers: SignerInput[] =
      d.signers && d.signers.length
        ? d.signers.map((s) => ({
            roleKey: s.roleKey,
            order: s.order,
            required: s.required,
            displayName: s.displayName,
            phone: s.phone ? normalizePhone(s.phone) : null,
            userId: s.userId ?? null,
            relationship: s.relationship ?? null,
          }))
        : await buildDefaultSigners(c, {
            clinicId: access.clinicId,
            signerConfig: template.signer_config ?? {},
            patient: patient ?? null,
            appointmentId,
            creatorUserId: access.session.user.id,
          });
    if (!signers.length) return bad("no_signers");
    if (d.signers?.some((s) => s.userId)) {
      const members = new Set(
        (await c.query(`select user_id from clinic_members where clinic_id = $1 and active`, [access.clinicId])).rows.map(
          (r) => r.user_id as string
        )
      );
      if (d.signers.some((s) => s.userId && !members.has(s.userId))) return bad("invalid");
    }

    const id = await createDocument(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      patientId: d.patientId ?? null,
      templateId: template.id,
      title: (language === "ar" ? template.name_ar : null) || template.name,
      language,
      source: template.source,
      sourcePdfPath: template.source_pdf_path,
      // Everyone signs at once (2026-11-21), whatever an older template says.
      signingMode: "parallel",
      appointmentId,
      serviceId: d.serviceId ?? null,
      signers,
    });

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "document.create",
      entity: "document",
      entityId: id,
      detail: {
        templateId: template.id,
        patientId: d.patientId ?? null,
        appointmentId,
        appointmentResolved: !d.appointmentId && !!appointmentId,
      },
    });
    revalidatePath(`/c/${slug}/documents`);
    return { id };
  });
}

// -------------------------------------------------------------- draft edits

const overrideSchema = z.object({
  documentId: z.string().uuid(),
  fieldKey: z.string().trim().min(1).max(80),
  label: z.string().trim().max(120).default(""),
  labelAr: z.string().trim().max(120).default(""),
  value: z.string().trim().max(2000),
  isOneOff: z.boolean().default(false),
});

/**
 * Sets a value for this document alone.
 *
 * Deliberately does not touch the patient record. Staff correcting a spelling on
 * one consent form must not silently rewrite the file, and a value that only
 * makes sense once should not become a permanent field.
 */
export async function setFieldValueAction(
  slug: string,
  input: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  const parsed = overrideSchema.safeParse(input);
  if (!parsed.success) return bad("invalid");
  const d = parsed.data;

  return inClinic(access, async (c) => {
    const doc = (
      await c.query(`select id, status from documents where id = $1 and clinic_id = $2`, [
        d.documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!doc) return bad("not_found");
    if (!isEditable(doc)) return bad("terminal");

    await c.query(
      `insert into document_field_values
         (clinic_id, document_id, field_key, label, label_ar, value, is_override, is_one_off, sort)
       values ($1, $2, $3, $4, $5, $6, true, $7,
               (select coalesce(max(sort), 0) + 1 from document_field_values where document_id = $2))
       on conflict (document_id, field_key) do update
         set value = excluded.value, label = excluded.label, label_ar = excluded.label_ar,
             is_override = true`,
      [
        access.clinicId,
        d.documentId,
        d.fieldKey,
        d.label,
        d.labelAr || null,
        d.value,
        d.isOneOff,
      ]
    );
    revalidatePath(`/c/${slug}/documents/${d.documentId}`);
    return {};
  });
}

export async function clearFieldValueAction(
  slug: string,
  documentId: string,
  fieldKey: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  return inClinic(access, async (c) => {
    const doc = (
      await c.query(`select status from documents where id = $1 and clinic_id = $2`, [
        documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!doc) return bad("not_found");
    if (!isEditable(doc)) return bad("terminal");
    await c.query(
      `delete from document_field_values where document_id = $1 and field_key = $2 and clinic_id = $3`,
      [documentId, fieldKey, access.clinicId]
    );
    revalidatePath(`/c/${slug}/documents/${documentId}`);
    return {};
  });
}

const signersSchema = z.object({
  documentId: z.string().uuid(),
  /** Ignored: a draft always goes out to everyone at once (2026-11-21). */
  mode: z.enum(["sequential", "parallel"]).optional(),
  signers: z.array(signerInputSchema).min(1).max(10),
});

export async function setSignersAction(slug: string, input: unknown): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  const parsed = signersSchema.safeParse(input);
  if (!parsed.success) return bad("invalid");
  const d = parsed.data;

  return inClinic(access, async (c) => {
    const doc = (
      await c.query(`select status from documents where id = $1 and clinic_id = $2`, [
        d.documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!doc) return bad("not_found");
    if (!isEditable(doc)) return bad("terminal");

    await c.query(`update documents set signing_mode = 'parallel' where id = $1 and clinic_id = $2`, [
      d.documentId,
      access.clinicId,
    ]);
    // A staff line names a real member of this clinic, or nobody.
    const memberIds = new Set(
      (
        await c.query(`select user_id from clinic_members where clinic_id = $1 and active`, [access.clinicId])
      ).rows.map((r) => r.user_id as string)
    );
    if (d.signers.some((s) => s.userId && !memberIds.has(s.userId))) return bad("invalid");
    await replaceSigners(
      c,
      access.clinicId,
      d.documentId,
      d.signers.map((s) => ({
        roleKey: s.roleKey,
        order: s.order,
        required: s.required,
        displayName: s.displayName,
        phone: s.phone ? normalizePhone(s.phone) : null,
        userId: s.userId ?? null,
        relationship: s.relationship ?? null,
      }))
    );
    revalidatePath(`/c/${slug}/documents/${d.documentId}`);
    return {};
  });
}

// ---------------------------------------------------------------- send flow

export type SendActionResult = {
  error?: string;
  missing?: string[];
  delivered?: number;
  staffNotified?: number;
  noPhone?: { id: string; name: string; role: string }[];
  waOffline?: boolean;
  link?: string;
};

export async function sendDocumentAction(
  slug: string,
  documentId: string,
  opts: { isResend?: boolean } = {}
): Promise<SendActionResult> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");

  const result = await inClinic(access, async (c) => {
    const doc = (
      await c.query(`select status, locked_by from documents where id = $1 and clinic_id = $2`, [
        documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!doc) return bad("not_found") as SendActionResult;
    if (isTerminal(doc)) return bad("terminal") as SendActionResult;

    const r = await sendDocument(c, {
      clinicId: access.clinicId,
      documentId,
      userId: access.session.user.id,
      isResend: opts.isResend,
    });
    if (!r.ok) return { error: r.error, missing: r.missing } as SendActionResult;

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: opts.isResend ? "document.resend" : "document.send",
      entity: "document",
      entityId: documentId,
      detail: { delivered: r.delivered },
    });
    return {
      delivered: r.delivered,
      staffNotified: r.staffNotified,
      noPhone: r.noPhone,
      waOffline: r.waOffline,
    } as SendActionResult;
  });

  revalidatePath(`/c/${slug}/documents`);
  revalidatePath(`/c/${slug}/documents/${documentId}`);
  return result;
}

/**
 * One WhatsApp message with a numbered list, for a patient who has several
 * documents waiting. Each still gets its own single-use link — a combined
 * signing session would make one signature cover several agreements.
 */
export async function sendAllPendingAction(
  slug: string,
  patientId: string
): Promise<{ error?: string; sent?: number }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");

  const result = await inClinic(access, (c) =>
    sendAllPendingForPatient(c, {
      clinicId: access.clinicId,
      patientId,
      userId: access.session.user.id,
    })
  );

  revalidatePath(`/c/${slug}/documents`);
  revalidatePath(`/c/${slug}/patients/${patientId}`);
  return result.ok ? { sent: result.sent } : bad(result.error);
}

export async function revokeLinkAction(
  slug: string,
  documentId: string,
  signerId: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  return inClinic(access, async (c) => {
    // The signer has to be on this document, or the event below would name the wrong one.
    const on = await c.query(
      `select 1 from document_signers where id = $1 and document_id = $2 and clinic_id = $3`,
      [signerId, documentId, access.clinicId]
    );
    if (!on.rowCount) return bad("not_found");
    const n = await revokeSignerTokens(c, signerId);
    if (!n) return bad("not_found");
    await logDocEvent(c, {
      clinicId: access.clinicId,
      documentId,
      signerId,
      type: "revoked",
      actorUserId: access.session.user.id,
      actorKind: "staff",
    });
    revalidatePath(`/c/${slug}/documents/${documentId}`);
    return {};
  });
}

/**
 * Puts a draft into circulation without messaging anyone, so a link can be
 * handed out by hand. A link to a draft used to be minted as it stood: the
 * signer opened a document that had never been frozen and could not sign it.
 */
async function ensureSent(
  c: PoolClient,
  clinicId: string,
  documentId: string,
  userId: string
): Promise<{ error?: string; missing?: string[] }> {
  const doc = (
    await c.query(`select status from documents where id = $1 and clinic_id = $2`, [documentId, clinicId])
  ).rows[0];
  if (!doc) return { error: "not_found" };
  if (isTerminal(doc)) return { error: "terminal" };
  if (doc.status !== "draft") return {};
  const r = await sendDocument(c, { clinicId, documentId, userId, suppressDelivery: true });
  return r.ok ? {} : { error: r.error, missing: r.missing };
}

/**
 * Mints a fresh link for one person and hands it back, so the clinic can send
 * it however it likes — the patient's WhatsApp, a guardian with no number on
 * file, a witness standing at the desk. Any outside signer may have one; staff
 * sign in the workspace. Minting revokes the person's earlier link.
 */
export async function copyLinkAction(
  slug: string,
  documentId: string,
  signerId: string
): Promise<{ url?: string; error?: string; missing?: string[] }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  const result = await inClinic(access, async (c) => {
    const clinic = await loadClinicDelivery(c, access.clinicId);
    const signer = (
      await c.query(
        `select id, status, user_id from document_signers where id = $1 and document_id = $2 and clinic_id = $3`,
        [signerId, documentId, access.clinicId]
      )
    ).rows[0];
    if (!signer) return bad("not_found");
    if (signer.status === "signed") return bad("already_signed");
    if (signer.status === "declined") return bad("terminal");
    if (signer.user_id) return bad("staff_signer");

    const sent = await ensureSent(c, access.clinicId, documentId, access.session.user.id);
    if (sent.error) return { error: sent.error, missing: sent.missing };

    const { url } = await issueSigningToken(c, {
      clinicId: access.clinicId,
      documentId,
      signerId,
      days: clinic.esign_link_days,
    });
    await logDocEvent(c, {
      clinicId: access.clinicId,
      documentId,
      signerId,
      type: "resent",
      actorUserId: access.session.user.id,
      actorKind: "staff",
      metadata: { method: "copied_link" },
    });
    return { url };
  });
  revalidatePath(`/c/${slug}/documents`);
  revalidatePath(`/c/${slug}/documents/${documentId}`);
  return result;
}

/**
 * Asks one person to sign now: an outside signer gets their link on WhatsApp,
 * a staff signer gets a notification (or, if they asked for it, their saved
 * signature). The per-person version of "send", so a guardian added late or a
 * doctor who missed the first notification can be chased on their own.
 */
export async function sendToSignerAction(
  slug: string,
  documentId: string,
  signerId: string
): Promise<{ error?: string; missing?: string[]; via?: "whatsapp" | "app" | "automatic"; url?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  const result = await inClinic(access, async (c) => {
    const sent = await ensureSent(c, access.clinicId, documentId, access.session.user.id);
    if (sent.error) return { error: sent.error, missing: sent.missing };

    const doc = (await c.query(`select * from documents where id = $1 and clinic_id = $2`, [documentId, access.clinicId])).rows[0];
    const signer = (await loadSigners(c, documentId, access.clinicId)).find((s) => s.id === signerId);
    if (!doc || !signer) return bad("not_found");
    if (signer.status === "signed") return bad("already_signed");
    if (signer.status === "declined") return bad("terminal");
    if (isTerminal(doc)) return bad("terminal");

    if (signer.user_id) {
      const auto = await autoSignStaff(c, { clinicId: access.clinicId, doc, due: [signer] });
      if (auto.signed.size) {
        if (auto.completed) await afterSignature(c, { clinicId: access.clinicId, documentId, patientId: doc.patient_id, completed: true });
        return { via: "automatic" as const };
      }
    }
    const clinic = await loadClinicDelivery(c, access.clinicId);
    const r = await deliverToSigner(c, { clinic, doc, signer, senderUserId: access.session.user.id });
    if (r.sent) return { via: "whatsapp" as const };
    if (r.reason === "staff") return signer.user_id ? { via: "app" as const } : bad("no_signer_chosen");
    if (r.reason === "no_phone") return bad("no_phone");
    if (r.reason === "wa_offline") return { error: "wa_disconnected", url: r.url };
    return bad("not_sent");
  });
  revalidatePath(`/c/${slug}/documents`);
  revalidatePath(`/c/${slug}/documents/${documentId}`);
  return result;
}

/**
 * Puts a member on a staff line that has nobody on it — the doctor of a
 * document raised without a visit, in a clinic with more than one doctor — or
 * swaps who it is before they have signed. Once the document is out, the
 * person chosen is asked straight away (or signed for, if they asked to be).
 */
export async function assignStaffSignerAction(
  slug: string,
  documentId: string,
  signerId: string,
  userId: string
): Promise<{ error?: string; via?: "app" | "automatic" }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  if (!z.string().uuid().safeParse(userId).success) return bad("invalid");
  const result = await inClinic(access, async (c) => {
    const doc = (await c.query(`select * from documents where id = $1 and clinic_id = $2`, [documentId, access.clinicId])).rows[0];
    if (!doc) return bad("not_found");
    if (isTerminal(doc)) return bad("terminal");
    const signer = (await loadSigners(c, documentId, access.clinicId)).find((s) => s.id === signerId);
    if (!signer) return bad("not_found");
    if (signer.status === "signed" || signer.status === "declined") return bad("already_signed");
    const role = (
      await c.query(`select is_staff from signer_roles where clinic_id = $1 and key = $2`, [access.clinicId, signer.role_key])
    ).rows[0];
    if (!(role?.is_staff ?? isStaffRole(signer.role_key))) return bad("invalid");
    const member = (
      await c.query(
        `select u.id, u.full_name from clinic_members cm join users u on u.id = cm.user_id
          where cm.clinic_id = $1 and cm.user_id = $2 and cm.active`,
        [access.clinicId, userId]
      )
    ).rows[0];
    if (!member) return bad("invalid");

    await c.query(
      `update document_signers set user_id = $3, display_name = $4, phone_e164 = null
        where id = $1 and clinic_id = $2`,
      [signerId, access.clinicId, member.id, member.full_name]
    );
    await revokeSignerTokens(c, signerId);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "document.signer_assigned",
      entity: "document",
      entityId: documentId,
      detail: { signerId, assignedUserId: member.id, role: signer.role_key },
    });
    if (doc.status === "draft") return {};

    const fresh = (await loadSigners(c, documentId, access.clinicId)).find((s) => s.id === signerId)!;
    const auto = await autoSignStaff(c, { clinicId: access.clinicId, doc, due: [fresh] });
    if (auto.signed.size) {
      if (auto.completed) await afterSignature(c, { clinicId: access.clinicId, documentId, patientId: doc.patient_id, completed: true });
      return { via: "automatic" as const };
    }
    const clinic = await loadClinicDelivery(c, access.clinicId);
    await deliverToSigner(c, { clinic, doc, signer: fresh, senderUserId: access.session.user.id });
    return { via: "app" as const };
  });
  revalidatePath(`/c/${slug}/documents`);
  revalidatePath(`/c/${slug}/documents/${documentId}`);
  return result;
}

/**
 * "Sign documents for me automatically" — the member's own switch, for this
 * clinic only. Never another member's: RLS lets any member write any member
 * row of the clinic, so the row is pinned to the caller here.
 */
export async function setMyAutoSignAction(slug: string, on: boolean): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!access.memberId) return bad("forbidden");
  // Somebody else's standing instruction to sign is not something a visitor sets.
  if (access.session.impersonatedBy) return bad("forbidden");
  return inClinic(access, async (c) => {
    if (on) {
      const saved = (await c.query(`select signature_png_path from users where id = $1`, [access.session.user.id])).rows[0];
      if (!saved?.signature_png_path) return bad("no_saved_signature");
    }
    const r = await c.query(
      `update clinic_members set auto_sign_documents = $3 where id = $1 and user_id = $2 and clinic_id = $4`,
      [access.memberId, access.session.user.id, !!on, access.clinicId]
    );
    if (!r.rowCount) return bad("not_found");
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: on ? "signature.auto_on" : "signature.auto_off",
      entity: "clinic_member",
      entityId: access.memberId ?? undefined,
    });
    revalidatePath(`/c/${slug}/signature`);
    return {};
  });
}

// ---------------------------------------------------------- void / supersede

export async function voidDocumentAction(
  slug: string,
  documentId: string,
  reason: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  // Voiding keeps the record but marks it dead on every page — a separate
  // capability from managing documents, and off by default, because "created
  // the wrong form" and "cancelled a signed agreement" are not the same job.
  if (!can(access, "documents.void")) return bad("forbidden");

  const result = await inClinic(access, async (c) => {
    const r = await voidDocument(c, {
      clinicId: access.clinicId,
      documentId,
      userId: access.session.user.id,
      reason,
    });
    if (r.error) return r;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "document.void",
      entity: "document",
      entityId: documentId,
      detail: { reason },
    });
    // Re-render the PDF so the filed copy carries the void mark too.
    await c.query(
      `insert into jobs (clinic_id, kind, payload, dedupe_key)
       values ($1, 'document:finalize', $2, $3) on conflict (dedupe_key) do nothing`,
      [
        access.clinicId,
        JSON.stringify({ documentId }),
        `document:finalize:void:${documentId}`,
      ]
    );
    return {};
  });

  revalidatePath(`/c/${slug}/documents`);
  revalidatePath(`/c/${slug}/documents/${documentId}`);
  return result;
}

/** Creates a new document that references and replaces a finished one. */
export async function supersedeDocumentAction(
  slug: string,
  documentId: string
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");

  return inClinic(access, async (c) => {
    const old = (
      await c.query(`select * from documents where id = $1 and clinic_id = $2`, [
        documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!old) return bad("not_found");

    const signers = await loadSigners(c, documentId, access.clinicId);
    const id = await createDocument(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      patientId: old.patient_id,
      templateId: old.template_id,
      title: old.title,
      language: old.language,
      source: old.source,
      sourcePdfPath: old.source_pdf_path,
      // A replacement is a new document, so it goes out to everyone at once.
      signingMode: "parallel",
      appointmentId: old.appointment_id,
      serviceId: old.service_id,
      supersedesDocumentId: documentId,
      signers: signers.map((s) => ({
        roleKey: s.role_key,
        order: s.signing_order,
        required: s.is_required,
        displayName: s.display_name,
        phone: s.phone_e164,
        userId: s.user_id,
        relationship: s.relationship,
      })),
    });
    revalidatePath(`/c/${slug}/documents`);
    return { id };
  });
}

// ------------------------------------------------------------- staff signing

const staffSignSchema = z.object({
  documentId: z.string().uuid(),
  signerId: z.string().uuid(),
  /** Omitted when the staff member is applying their saved signature. */
  pngDataUrl: z.string().max(2_500_000).optional(),
  svg: z.string().max(400_000).nullable().optional(),
  fieldAnswers: z.record(z.string(), z.unknown()).default({}),
  /** Persists the drawn signature for next time. */
  saveForLater: z.boolean().default(true),
});

/**
 * A staff signer applying their signature from inside the workspace.
 *
 * The two-tap path: the signature already stored on their account is reused, so
 * the request carries no image at all. A first-time signer draws once and it is
 * saved here, which is what makes every subsequent document two taps.
 */
export async function signAsStaffAction(
  slug: string,
  input: unknown
): Promise<{ error?: string; completed?: boolean }> {
  const access = await requireClinic(slug);
  const parsed = staffSignSchema.safeParse(input);
  if (!parsed.success) return bad("invalid");
  const d = parsed.data;
  const meta = await requestMeta();

  const outcome = await inClinic(access, async (c) => {
    const signer = (
      await c.query(
        `select id, user_id, role_key from document_signers
         where id = $1 and document_id = $2 and clinic_id = $3`,
        [d.signerId, d.documentId, access.clinicId]
      )
    ).rows[0];
    if (!signer) return bad("not_found");
    // Nobody signs on behalf of another. The signer row names a user, and it has
    // to be the user making the request.
    if (signer.user_id !== access.session.user.id) return bad("forbidden");

    let png = d.pngDataUrl;
    if (png && d.saveForLater) {
      await saveStaffSignature(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        pngDataUrl: png,
        svg: d.svg ?? null,
      });
    }
    if (!png) {
      const saved = (
        await c.query(`select signature_png_path from users where id = $1`, [
          access.session.user.id,
        ])
      ).rows[0];
      if (!saved?.signature_png_path) return bad("no_saved_signature");
      const { readFileBuffer } = await import("@/lib/storage");
      const buf = await readFileBuffer(saved.signature_png_path);
      if (!buf) return bad("no_saved_signature");
      png = `data:image/png;base64,${buf.toString("base64")}`;
    }

    const r = await recordSignature(c, {
      clinicId: access.clinicId,
      documentId: d.documentId,
      signerId: d.signerId,
      input: {
        pngDataUrl: png,
        svg: d.svg ?? null,
        consentConfirmed: true,
        fieldAnswers: d.fieldAnswers,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
      actorUserId: access.session.user.id,
    });
    if (!r.ok) return bad(r.error);

    await afterSignature(c, {
      clinicId: access.clinicId,
      documentId: d.documentId,
      patientId: null,
      completed: r.completed,
    });
    await emitDocumentTrigger(c, access.clinicId, "document_signed", {
      documentId: d.documentId,
      signerId: d.signerId,
    });
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "document.sign",
      entity: "document",
      entityId: d.documentId,
      detail: { role: signer.role_key },
    });
    return { completed: r.completed };
  });

  revalidatePath(`/c/${slug}/documents`);
  revalidatePath(`/c/${slug}/documents/${d.documentId}`);
  return outcome;
}

export async function declineAsStaffAction(
  slug: string,
  documentId: string,
  signerId: string,
  reason: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  const meta = await requestMeta();

  const result = await inClinic(access, async (c) => {
    const signer = (
      await c.query(
        `select s.user_id, s.display_name, d.title from document_signers s
           join documents d on d.id = s.document_id
         where s.id = $1 and s.document_id = $2 and s.clinic_id = $3`,
        [signerId, documentId, access.clinicId]
      )
    ).rows[0];
    if (!signer) return bad("not_found");
    if (signer.user_id !== access.session.user.id) return bad("forbidden");

    const r = await declineDocument(c, {
      clinicId: access.clinicId,
      documentId,
      signerId,
      reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
      actorUserId: access.session.user.id,
    });
    if (!r.ok) return bad(r.error ?? "not_found");

    await notifyStaffOfSignerAction(c, {
      clinicId: access.clinicId,
      clinicSlug: slug,
      doc: { id: documentId, title: signer.title ?? "" },
      signerName: signer.display_name,
      action: "declined",
      reason,
    });
    await emitDocumentTrigger(c, access.clinicId, "document_declined", { documentId });
    return {};
  });

  revalidatePath(`/c/${slug}/documents/${documentId}`);
  return result;
}

// --------------------------------------------------------------- in person

/**
 * Claims the document for a device that is about to be handed to a patient.
 *
 * The lock is what stops a second staff member opening the same document while
 * a patient is holding a tablet on it — two people signing the same signature
 * slot is not a conflict any later reconciliation can fix.
 */
export async function startInPersonAction(
  slug: string,
  documentId: string
): Promise<{ error?: string; heldBy?: string; signerId?: string; missing?: string[] }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");

  return inClinic(access, async (c) => {
    const doc = (
      await c.query(`select * from documents where id = $1 and clinic_id = $2`, [
        documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!doc) return bad("not_found");
    if (isTerminal(doc)) return bad("terminal");

    const lock = await acquireLock(c, access.clinicId, documentId, access.session.user.id);
    if (!lock.ok) return { error: "locked", heldBy: lock.heldBy };

    // Handing over a tablet is a form of sending: the document has to freeze
    // before anyone reads it, on exactly the same terms as a remote link.
    const sent = await sendDocument(c, {
      clinicId: access.clinicId,
      documentId,
      userId: access.session.user.id,
    });
    if (!sent.ok) {
      await releaseLock(c, access.clinicId, documentId, access.session.user.id);
      return { error: sent.error, missing: sent.missing };
    }

    const signers = await loadSigners(c, documentId, access.clinicId);
    const due = signersDueNow(signers, doc.signing_mode).filter((s) => !s.user_id);
    if (!due.length) return bad("no_signers");
    return { signerId: due[0].id };
  });
}

export async function releaseInPersonAction(slug: string, documentId: string): Promise<void> {
  const access = await requireClinic(slug);
  await inClinic(access, (c) =>
    releaseLock(c, access.clinicId, documentId, access.session.user.id)
  );
  revalidatePath(`/c/${slug}/documents/${documentId}`);
}

// ------------------------------------------------------ staff signature + PIN

export async function saveMySignatureAction(
  slug: string,
  pngDataUrl: string,
  svg: string | null
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  return inClinic(access, async (c) => {
    const r = await saveStaffSignature(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      pngDataUrl,
      svg,
    });
    if (!r.ok) return bad(r.error ?? "bad_signature");
    // The page lives at /signature, not under settings: revalidating the old
    // path left a first-time signer looking at "no signature yet" after saving.
    revalidatePath(`/c/${slug}/signature`);
    return {};
  });
}

export async function setKioskPinAction(slug: string, pin: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!/^\d{4,8}$/.test(pin)) return bad("pinTooShort");
  const { hashPassword } = await import("@/lib/auth");
  await inClinic(access, (c) =>
    c.query(`update users set kiosk_pin_hash = $2 where id = $1`, [
      access.session.user.id,
      hashPassword(pin),
    ])
  );
  revalidatePath(`/c/${slug}/signature`);
  return {};
}

/** Unlocks the in-clinic signing view. PIN if one is set, password otherwise. */
export async function verifyKioskUnlockAction(
  slug: string,
  secret: string
): Promise<{ ok: boolean }> {
  const access = await requireClinic(slug);
  const { verifyPassword } = await import("@/lib/auth");
  return inClinic(access, async (c) => {
    const u = (
      await c.query(`select kiosk_pin_hash, password_hash from users where id = $1`, [
        access.session.user.id,
      ])
    ).rows[0];
    if (!u) return { ok: false };
    const hash = u.kiosk_pin_hash ?? u.password_hash;
    return { ok: verifyPassword(secret, hash) };
  });
}

// ------------------------------------------------------------ missing fields

