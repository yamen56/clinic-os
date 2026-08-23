import type { PoolClient } from "pg";
import {
  buildDefaultSigners,
  createDocument,
  freezeDocument,
  loadSigners,
  markSent,
  signersDueNow,
  type DocumentRow,
} from "./documents";
import {
  clinicDisplayName,
  documentMessage,
  dispatchDueSigners,
  firstName,
  loadClinicDelivery,
} from "./delivery";
import { resolveContextAppointment } from "./fields";
import { issueSigningToken } from "./tokens";
import { queueWhatsAppMessage } from "../outbound";
import { enqueueFinalize, scheduleReminders, emitDocumentTrigger } from "./jobs";
import { logDocEvent } from "./events";
import { refreshDocumentStatus } from "./documents";

/**
 * One way to put a template into a patient's hands.
 *
 * The staff UI, the automation engine and the "service needs a consent form"
 * recipe all end up here, so a document raised by a robot at 3am is
 * indistinguishable from one a receptionist raised by hand: same freeze, same
 * hash, same audit trail, same reminders.
 */

export type SendResult =
  | {
      ok: true;
      documentId: string;
      delivered: number;
      staffNotified: number;
      noPhone: { id: string; name: string; role: string }[];
      waOffline: boolean;
      completed: boolean;
    }
  | { ok: false; error: string; missing?: string[] };

export async function createAndSendFromTemplate(
  c: PoolClient,
  args: {
    clinicId: string;
    userId: string | null;
    templateId: string;
    patientId?: string | null;
    appointmentId?: string | null;
    serviceId?: string | null;
    /** Overrides the template's default signer set. */
    signers?: Parameters<typeof createDocument>[1]["signers"];
    language?: "ar" | "en";
  }
): Promise<SendResult> {
  const template = (
    await c.query(
      `select id, name, name_ar, signer_config, language, source, source_pdf_path
       from document_templates where id = $1 and clinic_id = $2 and is_active`,
      [args.templateId, args.clinicId]
    )
  ).rows[0];
  if (!template) return { ok: false, error: "template_not_found" };

  const clinicRow = (
    await c.query(`select default_locale from clinics where id = $1`, [args.clinicId])
  ).rows[0];

  const patient = args.patientId
    ? (
        await c.query(
          `select id, full_name, phone_e164, birth_date from patients where id = $1 and clinic_id = $2`,
          [args.patientId, args.clinicId]
        )
      ).rows[0]
    : null;

  // The patient's own language wins over the clinic default where we know it;
  // a template authored in one language only falls back to what exists.
  let language: "ar" | "en" =
    args.language ?? (clinicRow?.default_locale === "en" ? "en" : "ar");
  if (template.language === "ar") language = "ar";
  if (template.language === "en") language = "en";

  // Same fallback as the staff path: a document about a patient is about a visit,
  // and that visit is where the doctor, service and price come from.
  const appointmentId =
    args.appointmentId ??
    (args.patientId ? await resolveContextAppointment(c, args.clinicId, args.patientId) : null);

  const signers =
    args.signers ??
    (await buildDefaultSigners(c, {
      clinicId: args.clinicId,
      signerConfig: template.signer_config ?? {},
      patient: patient ?? null,
      appointmentId,
    }));

  const title = (language === "ar" ? template.name_ar : null) || template.name;

  const documentId = await createDocument(c, {
    clinicId: args.clinicId,
    userId: args.userId,
    patientId: args.patientId ?? null,
    templateId: template.id,
    title,
    language,
    source: template.source,
    sourcePdfPath: template.source_pdf_path,
    signingMode: (template.signer_config?.mode ?? "sequential") as "sequential" | "parallel",
    appointmentId,
    serviceId: args.serviceId ?? null,
    signers,
  });

  return sendDocument(c, { clinicId: args.clinicId, documentId, userId: args.userId });
}

/**
 * Freezes a draft and puts it in front of whoever is due.
 *
 * Refuses rather than guesses when a merge value is missing: an empty blank on
 * a consent form is not a cosmetic problem, so the caller gets the list of
 * fields and the staff member gets a link straight to the one that is empty.
 */
export async function sendDocument(
  c: PoolClient,
  args: {
    clinicId: string;
    documentId: string;
    userId?: string | null;
    isResend?: boolean;
    /**
     * Freeze and put into circulation, but send nothing.
     *
     * For the bundled "send all pending" path, which mints its own links and
     * delivers them as one numbered message. Without this the patient received an
     * individual message per document *and* the bundle.
     */
    suppressDelivery?: boolean;
  }
): Promise<SendResult> {
  const frozen = await freezeDocument(c, args.clinicId, args.documentId);
  if ("error" in frozen) {
    return { ok: false, error: frozen.error, missing: frozen.missing };
  }

  const doc = (
    await c.query(`select * from documents where id = $1 and clinic_id = $2`, [
      args.documentId,
      args.clinicId,
    ])
  ).rows[0] as DocumentRow;

  const clinic = await loadClinicDelivery(c, args.clinicId);
  const signers = await loadSigners(c, args.documentId, args.clinicId);
  const due = signersDueNow(signers, doc.signing_mode);

  const result = args.suppressDelivery
    ? (await markSent(c, args.clinicId, args.documentId, clinic.esign_link_days),
      { delivered: 0, staff: 0, noPhone: [], waOffline: false })
    : await dispatchDueSigners(c, {
        clinic,
        doc,
        due,
        senderUserId: args.userId ?? null,
      });

  if (args.isResend) {
    await logDocEvent(c, {
      clinicId: args.clinicId,
      documentId: args.documentId,
      type: "resent",
      actorUserId: args.userId ?? null,
      actorKind: args.userId ? "staff" : "system",
    });
  }

  // A document whose only signers are staff has nothing to wait for on the
  // patient's side; the doctor's push has already gone out.
  await refreshDocumentStatus(c, args.clinicId, args.documentId);

  if (result.delivered > 0) {
    await scheduleReminders(c, args.clinicId, args.documentId, 24);
  }
  await emitDocumentTrigger(c, args.clinicId, "document_sent", {
    documentId: args.documentId,
    patientId: doc.patient_id,
  });

  return {
    ok: true,
    documentId: args.documentId,
    delivered: result.delivered,
    staffNotified: result.staff,
    noPhone: result.noPhone.map((s) => ({ id: s.id, name: s.display_name, role: s.role_key })),
    waOffline: result.waOffline,
    completed: false,
  };
}

/**
 * Everything a patient still owes, as one WhatsApp message with a numbered list.
 *
 * Each document keeps its own single-use link — a combined signing session would
 * let one signature cover several agreements, which is exactly what the brief
 * rules out. What is combined is only the *message*.
 *
 * Delivery is suppressed on each individual send for the same reason: the first
 * version of this sent an individual message per document and then the bundle on
 * top, so a patient with two forms got three messages.
 */
export async function sendAllPendingForPatient(
  c: PoolClient,
  args: { clinicId: string; patientId: string; userId?: string | null }
): Promise<
  | { ok: true; sent: number; items: { title: string; url: string }[] }
  | { ok: false; error: string; blocked?: { documentId: string; error: string }[] }
> {
  const clinic = await loadClinicDelivery(c, args.clinicId);
  const patient = (
    await c.query(
      `select id, full_name, phone_e164 from patients where id = $1 and clinic_id = $2`,
      [args.patientId, args.clinicId]
    )
  ).rows[0];
  if (!patient) return { ok: false, error: "not_found" };
  if (!patient.phone_e164) return { ok: false, error: "no_phone" };
  if (!clinic.wa_connected) return { ok: false, error: "wa_disconnected" };

  const docs = await c.query(
    `select id, title, language, signing_mode from documents
     where clinic_id = $1 and patient_id = $2
       and status in ('draft', 'sent', 'partially_signed')
     order by created_at`,
    [args.clinicId, args.patientId]
  );
  if (!docs.rowCount) return { ok: true, sent: 0, items: [] };

  const items: { title: string; url: string }[] = [];
  const blocked: { documentId: string; error: string }[] = [];

  for (const doc of docs.rows) {
    const sent = await sendDocument(c, {
      clinicId: args.clinicId,
      documentId: doc.id,
      userId: args.userId,
      suppressDelivery: true,
    });
    if (!sent.ok) {
      // A document with an empty merge field is skipped, not silently dropped.
      blocked.push({ documentId: doc.id, error: sent.error });
      continue;
    }

    const signers = await loadSigners(c, doc.id, args.clinicId);
    const patientSigner = signersDueNow(signers, doc.signing_mode).find(
      (s) => s.role_key === "patient" && s.phone_e164 && !s.user_id
    );
    if (!patientSigner) continue;

    const { url } = await issueSigningToken(c, {
      clinicId: args.clinicId,
      documentId: doc.id,
      signerId: patientSigner.id,
      days: clinic.esign_link_days,
    });
    items.push({ title: doc.title, url });
    await logDocEvent(c, {
      clinicId: args.clinicId,
      documentId: doc.id,
      signerId: patientSigner.id,
      type: "sent",
      actorUserId: args.userId ?? null,
      actorKind: args.userId ? "staff" : "system",
      metadata: { bundled: true },
    });
  }

  if (!items.length) return { ok: false, error: "nothing_sendable", blocked };

  const lang = (docs.rows[0].language ?? clinic.default_locale) as "ar" | "en";
  const msg = await documentMessage(c, {
    clinicId: args.clinicId,
    key: "document_bundle",
    lang,
    clinicName: clinicDisplayName(clinic, lang),
    patientFirstName: firstName(patient.full_name),
    items,
  });
  await queueWhatsAppMessage(c, {
    clinicId: args.clinicId,
    phoneE164: patient.phone_e164,
    senderKind: "staff",
    senderUserId: args.userId ?? null,
    body: msg.body,
    patientId: args.patientId,
  });

  return { ok: true, sent: items.length, items };
}

/** Called after any signature lands, from whichever surface recorded it. */
export async function afterSignature(
  c: PoolClient,
  args: { clinicId: string; documentId: string; patientId: string | null; completed: boolean }
): Promise<void> {
  if (args.completed) {
    await enqueueFinalize(c, args.clinicId, args.documentId);
    return;
  }
  await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'document:advance', $2)`, [
    args.clinicId,
    JSON.stringify({ documentId: args.documentId }),
  ]);
}
