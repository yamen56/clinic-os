"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { notifyClinicStaff } from "@/lib/notify";
import {
  acquireLock,
  BODY_OVERRIDE_KEY,
  buildDefaultSigners,
  buildMergeTable,
  createDocument,
  isEditable,
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
  clinicDisplayName,
  firstName,
  loadClinicDelivery,
  notifyStaffOfSignerAction,
} from "@/lib/esign/delivery";
import { logDocEvent } from "@/lib/esign/events";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { emitDocumentTrigger } from "@/lib/esign/jobs";
import { sanitizeHtml } from "@/lib/esign/render";

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
          });
    if (!signers.length) return bad("no_signers");

    const id = await createDocument(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      patientId: d.patientId ?? null,
      templateId: template.id,
      title: (language === "ar" ? template.name_ar : null) || template.name,
      language,
      source: template.source,
      sourcePdfPath: template.source_pdf_path,
      signingMode: (template.signer_config?.mode ?? "sequential") as "sequential" | "parallel",
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

/** Edits the wording of one document, without touching the template. */
export async function setDocumentBodyAction(
  slug: string,
  documentId: string,
  html: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  return inClinic(access, async (c) => {
    const doc = (
      await c.query(`select status, language from documents where id = $1 and clinic_id = $2`, [
        documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!doc) return bad("not_found");
    if (!isEditable(doc)) return bad("terminal");

    /*
      A per-document body override lives on the document as an unfrozen draft
      body. It is stored in `content_snapshot` only once the document is frozen;
      until then it sits in a one-off field value under a reserved key, so the
      freeze path picks it up without a second column.
    */
    await c.query(
      `insert into document_field_values
         (clinic_id, document_id, field_key, label, value, is_override, is_one_off, sort)
       values ($1, $2, $4, 'Body', $3, true, false, -1)
       on conflict (document_id, field_key) do update set value = excluded.value`,
      [access.clinicId, documentId, sanitizeHtml(html).slice(0, 80_000), BODY_OVERRIDE_KEY]
    );
    revalidatePath(`/c/${slug}/documents/${documentId}`);
    return {};
  });
}

const signersSchema = z.object({
  documentId: z.string().uuid(),
  mode: z.enum(["sequential", "parallel"]),
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

    await c.query(`update documents set signing_mode = $3 where id = $1 and clinic_id = $2`, [
      d.documentId,
      access.clinicId,
      d.mode,
    ]);
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

/** Mints a fresh link and hands it back, for a clinic sending it another way. */
export async function copyLinkAction(
  slug: string,
  documentId: string,
  signerId: string
): Promise<{ url?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents.manage")) return bad("forbidden");
  return inClinic(access, async (c) => {
    const clinic = await loadClinicDelivery(c, access.clinicId);
    const signer = (
      await c.query(
        `select id, status from document_signers where id = $1 and document_id = $2 and clinic_id = $3`,
        [signerId, documentId, access.clinicId]
      )
    ).rows[0];
    if (!signer) return bad("not_found");
    if (signer.status === "signed") return bad("already_signed");

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
      signingMode: old.signing_mode,
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
        `select user_id, display_name from document_signers
         where id = $1 and document_id = $2 and clinic_id = $3`,
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
      doc: { id: documentId, title: "" },
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
    revalidatePath(`/c/${slug}/settings/signature`);
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
  revalidatePath(`/c/${slug}/settings/signature`);
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

/** The merge table for a draft, for the preview panel. */
export async function loadMergeTableAction(
  slug: string,
  documentId: string
): Promise<{ error?: string; missing?: { key: string; label: string; fixHint: string | null }[] }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents")) return bad("forbidden");
  return inClinic(access, async (c) => {
    const doc = (
      await c.query(`select * from documents where id = $1 and clinic_id = $2`, [
        documentId,
        access.clinicId,
      ])
    ).rows[0];
    if (!doc) return bad("not_found");
    const template = doc.template_id
      ? (await c.query(`select body, body_ar from document_templates where id = $1`, [doc.template_id]))
          .rows[0]
      : null;
    const body =
      doc.language === "ar"
        ? template?.body_ar || template?.body || ""
        : template?.body || template?.body_ar || "";
    const table = await buildMergeTable(c, {
      clinicId: access.clinicId,
      documentId,
      body,
      locale: doc.language,
      patientId: doc.patient_id,
      appointmentId: doc.appointment_id,
      serviceId: doc.service_id,
    });
    return {
      missing: table.missing.map((m) => ({
        key: m.key,
        label: doc.language === "ar" ? m.labelAr : m.label,
        fixHint: m.fixHint,
      })),
    };
  });
}

/** Reception asks staff for a new link on the patient's behalf. */
export async function requestNewLinkAction(
  slug: string,
  documentId: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "documents")) return bad("forbidden");
  return inClinic(access, async (c) => {
    await notifyClinicStaff(c, access.clinicId, {
      kind: "document_new_link",
      title: "A patient asked for a new signing link",
      url: `/c/${slug}/documents/${documentId}`,
      roles: ["owner", "receptionist"],
    });
    return {};
  });
}
