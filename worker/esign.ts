import { DateTime } from "luxon";
import { withSystem } from "./db";
import { registerJobHandler } from "./jobs";
import { startRun } from "./automations";
import { generateFinalPdf } from "../src/lib/esign/pdf";
import {
  dispatchDueSigners,
  deliverToSigner,
  loadClinicDelivery,
  clinicDisplayName,
  signedCopyMessage,
  notifyStaffOfSignerAction,
} from "../src/lib/esign/delivery";
import { createAndSendFromTemplate } from "../src/lib/esign/flow";
import { loadSigners, signersDueNow, type DocumentRow } from "../src/lib/esign/documents";
import { logDocEvent } from "../src/lib/esign/events";
import { emitDocumentTrigger } from "../src/lib/esign/jobs";
import { queueWhatsAppMessage } from "../src/lib/outbound";
import { notifyClinicStaff, notifyUser } from "../src/lib/notify";

/**
 * Document work that must not happen inside a request.
 *
 * Finalising means launching a browser and building a PDF; delivering means
 * queuing WhatsApp. Both are slow and both can fail transiently, so they run as
 * jobs with the retry behaviour the job runner already provides. Every handler
 * re-reads the document first, because by the time a job runs the document may
 * have been voided, declined, or already finished by someone else.
 */

async function loadDoc(documentId: string): Promise<DocumentRow | null> {
  return withSystem(async (c) => {
    const r = await c.query(`select * from documents where id = $1`, [documentId]);
    return (r.rows[0] as DocumentRow) ?? null;
  });
}

/**
 * Builds the finished PDF and puts it where everyone expects it: the patient's
 * own WhatsApp thread, and therefore the clinic's conversation view too.
 */
async function finalize(documentId: string): Promise<void> {
  const doc = await loadDoc(documentId);
  if (!doc) return;
  if (doc.status !== "completed" && doc.status !== "voided") return;

  const result = await generateFinalPdf(documentId);
  if ("error" in result) throw new Error(`document pdf failed: ${result.error}`);

  await withSystem(async (c) => {
    const clinic = await loadClinicDelivery(c, doc.clinic_id);
    const slug = (await c.query(`select slug from clinics where id = $1`, [doc.clinic_id])).rows[0]
      ?.slug as string;

    // The patient keeps their own copy without having to ask for it.
    const patientSigner = (await loadSigners(c, documentId, doc.clinic_id)).find(
      (s) => s.role_key === "patient" && s.phone_e164
    );
    if (doc.status === "completed" && patientSigner?.phone_e164 && clinic.wa_connected) {
      await queueWhatsAppMessage(c, {
        clinicId: doc.clinic_id,
        phoneE164: patientSigner.phone_e164,
        senderKind: "system",
        body: signedCopyMessage({
          lang: doc.language,
          clinicName: clinicDisplayName(clinic, doc.language),
          title: doc.title,
        }),
        msgType: "document",
        mediaPath: result.path,
        mediaName: `${doc.title.slice(0, 50)}.pdf`,
        mediaMime: "application/pdf",
        patientId: doc.patient_id,
      });
    }

    if (doc.status === "completed") {
      await notifyStaffOfSignerAction(c, {
        clinicId: doc.clinic_id,
        clinicSlug: slug,
        doc: { id: doc.id, title: doc.title },
        signerName: "",
        action: "completed",
      });
      await emitDocumentTrigger(c, doc.clinic_id, "document_completed", {
        documentId: doc.id,
        patientId: doc.patient_id,
      });
    }
  });
}

/**
 * Moves a sequential document to whoever is next.
 *
 * Called after each signature. Nobody is told about their turn before it is
 * actually their turn — that is the whole point of sequential mode.
 */
async function advance(documentId: string): Promise<void> {
  const doc = await loadDoc(documentId);
  if (!doc) return;
  if (doc.status !== "sent" && doc.status !== "partially_signed") return;

  await withSystem(async (c) => {
    const clinic = await loadClinicDelivery(c, doc.clinic_id);
    const signers = await loadSigners(c, documentId, doc.clinic_id);
    const due = signersDueNow(signers, doc.signing_mode);
    // Only reach out to signers who have not been contacted yet; re-notifying
    // somebody who already has a live link is how a patient gets two messages.
    const fresh = due.filter((s) => s.status === "pending" && !s.link_opened_at);
    if (!fresh.length) return;
    await dispatchDueSigners(c, { clinic, doc, due: fresh });
  });
}

/** Reminder to a patient who has not signed yet. Silent if they since have. */
async function remind(documentId: string): Promise<void> {
  const doc = await loadDoc(documentId);
  if (!doc) return;
  if (doc.status !== "sent" && doc.status !== "partially_signed") return;

  await withSystem(async (c) => {
    const clinic = await loadClinicDelivery(c, doc.clinic_id);
    const signers = await loadSigners(c, documentId, doc.clinic_id);
    const due = signersDueNow(signers, doc.signing_mode).filter(
      (s) => s.status !== "signed" && s.phone_e164 && !s.user_id
    );
    for (const s of due) {
      await deliverToSigner(c, { clinic, doc, signer: s, isReminder: true });
    }
  });
}

/**
 * Expires links whose window closed.
 *
 * Expiry is a state the patient can act on, not a dead end: the page they land
 * on offers a "request a new link" button, and staff hear about it here.
 */
export async function sweepExpiredDocuments(): Promise<void> {
  await withSystem(async (c) => {
    const due = await c.query(
      `select d.id, d.clinic_id, d.title, d.patient_id, cl.slug
       from documents d join clinics cl on cl.id = d.clinic_id
       where d.status in ('sent', 'partially_signed')
         and d.expires_at is not null and d.expires_at < now()
       limit 200`
    );
    for (const doc of due.rows) {
      await c.query(`update documents set status = 'expired' where id = $1`, [doc.id]);
      await c.query(
        `update signing_tokens set revoked_at = coalesce(revoked_at, now()) where document_id = $1`,
        [doc.id]
      );
      await logDocEvent(c, {
        clinicId: doc.clinic_id,
        documentId: doc.id,
        type: "expired",
        actorKind: "system",
      });
      await notifyClinicStaff(c, doc.clinic_id, {
        kind: "document_expired",
        title: `"${doc.title}" expired unsigned`,
        body: "The signing link is no longer valid. Send a new one if it is still needed.",
        url: `/c/${doc.slug}/documents/${doc.id}`,
        roles: ["owner", "receptionist"],
      });
      await emitDocumentTrigger(c, doc.clinic_id, "document_expired", {
        documentId: doc.id,
        patientId: doc.patient_id,
      });
    }
  });
}

/**
 * Weekly digest for owners: what is still outstanding.
 *
 * Sent Sunday morning in the clinic's own timezone, which is the start of the
 * working week here — a digest that lands on a Jordanian owner's Saturday
 * evening is a digest nobody reads. The dedupe key is the ISO week, so a worker
 * restart inside the window cannot send it twice.
 */
export async function sendPendingDigest(): Promise<void> {
  await withSystem(async (c) => {
    const rows = await c.query(
      `select d.clinic_id, cl.slug, cl.timezone, count(*)::int as pending,
              count(*) filter (where d.expires_at < now() + interval '2 days')::int as expiring
       from documents d join clinics cl on cl.id = d.clinic_id
       where d.status in ('sent', 'partially_signed')
       group by d.clinic_id, cl.slug, cl.timezone`
    );
    for (const r of rows.rows) {
      const local = DateTime.now().setZone(r.timezone);
      if (local.weekday !== 7 || local.hour !== 9 || local.minute > 2) continue;

      const claim = await c.query(
        `insert into jobs (clinic_id, kind, payload, status, dedupe_key)
         values ($1, 'document:digest', $2, 'done', $3)
         on conflict (dedupe_key) do nothing
         returning id`,
        [
          r.clinic_id,
          JSON.stringify({ pending: r.pending }),
          `document:digest:${r.clinic_id}:${local.weekYear}-W${local.weekNumber}`,
        ]
      );
      if (!claim.rowCount) continue;

      const owners = await c.query(
        `select user_id from clinic_members where clinic_id = $1 and role = 'owner' and active`,
        [r.clinic_id]
      );
      for (const o of owners.rows) {
        await notifyUser(c, o.user_id, {
          clinicId: r.clinic_id,
          kind: "document_digest",
          title: `${r.pending} documents still waiting for signature`,
          body: r.expiring
            ? `${r.expiring} of them expire within two days.`
            : "Open the Documents list to chase them.",
          url: `/c/${r.slug}/documents`,
        });
      }
    }
  });
}

/**
 * "Document unsigned after X days" — the automation trigger, evaluated once a
 * day per clinic so a flow can chase what reminders did not.
 */
export async function sweepUnsignedDocuments(): Promise<void> {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone from automations a
       join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'document_unsigned'`
    );
    for (const auto of autos.rows) {
      const local = DateTime.now().setZone(auto.timezone);
      if (local.hour !== 10 || local.minute > 2) continue;
      const days = Number((auto.trigger_config ?? {}).days ?? 3);
      const docs = await c.query(
        `select id, patient_id from documents
         where clinic_id = $1 and status in ('sent', 'partially_signed')
           and sent_at is not null
           and sent_at::date = (current_date - ($2::text || ' days')::interval)::date
         limit 200`,
        [auto.clinic_id, days]
      );
      for (const d of docs.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, {
          patientId: d.patient_id,
          documentId: d.id,
        });
        if (runId) {
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [auto.clinic_id, JSON.stringify({ runId }), `docunsigned:${auto.id}:${d.id}`]
          );
        }
      }
    }
  });
}

/**
 * Raises and sends a service's required consent forms when its appointment is
 * confirmed.
 *
 * A direct hook rather than a shipped automation recipe, because which form is
 * needed depends on which service was booked — a single recipe would have to name
 * one template, and a clinic with six services would need six near-identical
 * flows. The per-service `auto_send` flag stays the switch, so a clinic can turn
 * any of it off without touching an automation.
 */
export async function autoSendServiceDocuments(
  clinicId: string,
  appointmentId: string
): Promise<void> {
  await withSystem(async (c) => {
    const appt = (
      await c.query(
        `select a.id, a.patient_id, a.service_id, a.status
         from appointments a where a.id = $1 and a.clinic_id = $2`,
        [appointmentId, clinicId]
      )
    ).rows[0];
    if (!appt || appt.status !== "confirmed" || !appt.service_id) return;

    const required = await c.query(
      `select sd.template_id from service_documents sd
       join document_templates t on t.id = sd.template_id and t.is_active
       where sd.service_id = $1 and sd.clinic_id = $2 and sd.auto_send`,
      [appt.service_id, clinicId]
    );
    if (!required.rowCount) return;

    const owner = (
      await c.query(
        `select user_id from clinic_members
         where clinic_id = $1 and role = 'owner' and active order by created_at limit 1`,
        [clinicId]
      )
    ).rows[0];

    for (const row of required.rows) {
      // Never twice for the same appointment: a status that flips to confirmed
      // again must not produce a second copy of the same consent form.
      const existing = await c.query(
        `select 1 from documents
         where clinic_id = $1 and template_id = $2 and appointment_id = $3 and status <> 'voided'`,
        [clinicId, row.template_id, appointmentId]
      );
      if (existing.rowCount) continue;

      const sent = await createAndSendFromTemplate(c, {
        clinicId,
        userId: owner?.user_id ?? null,
        templateId: row.template_id,
        patientId: appt.patient_id,
        appointmentId,
        serviceId: appt.service_id,
      });
      if (!sent.ok) {
        // A blocked send is a staff problem, not a silent one.
        await notifyClinicStaff(c, clinicId, {
          kind: "document_awaiting_signature",
          title: "A required consent form could not be sent automatically",
          body:
            sent.error === "missing_fields"
              ? `Missing patient details: ${(sent.missing ?? []).join(", ")}`
              : sent.error,
          url: `/c/${(await c.query(`select slug from clinics where id = $1`, [clinicId])).rows[0]?.slug}/documents`,
          roles: ["owner", "receptionist"],
        });
      }
    }
  });
}

export function registerEsignJobs(): void {
  registerJobHandler("document:finalize", async (payload) => {
    await finalize(String(payload.documentId));
  });
  registerJobHandler("document:advance", async (payload) => {
    await advance(String(payload.documentId));
  });
  registerJobHandler("document:remind", async (payload) => {
    await remind(String(payload.documentId));
  });
}
