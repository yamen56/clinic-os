import type { PoolClient } from "pg";
import { queueWhatsAppMessage } from "./outbound";
import { WA_REASON, canResend, deliveryNote } from "./wa-delivery";

/**
 * "Send again" on a message that never reached the patient's phone: failed,
 * not sent, or sent and still not delivered hours later.
 *
 * The copy is a new message rather than the old one put back in the queue.
 * The old one keeps its reason where the thread shows it — that is the record
 * of what went wrong — and a person asking for it again is a person deciding to
 * send it now, so the copy goes as theirs: ahead of queued automations, and
 * past the checks that cancel an automation's stale reminder (which would
 * otherwise cancel the very message they just asked for).
 *
 * "Not on WhatsApp" is asked again rather than believed: the answer is a day
 * old at most, but the person pressing the button has usually just fixed the
 * number or been told the patient installed it.
 */
export async function resendMessage(
  c: PoolClient,
  opts: { clinicId: string; conversationId: string; messageId: string; userId: string }
): Promise<{ ok: true; messageId: string } | { ok: false; error: "not_found" | "not_resendable" }> {
  const m = (
    await c.query(
      `select m.id, m.direction, m.status, m.error, m.created_at, m.sent_at, m.scheduled_at, m.delivered_at,
              m.resent_at, m.msg_type, m.body, m.media_path, m.media_name, m.media_mime, m.media_meta,
              cv.phone_e164, cv.patient_id
         from messages m join conversations cv on cv.id = m.conversation_id
        where m.id = $1 and m.conversation_id = $2 and m.clinic_id = $3
        for update of m`,
      [opts.messageId, opts.conversationId, opts.clinicId]
    )
  ).rows[0];
  if (!m || m.direction !== "out") return { ok: false, error: "not_found" };
  // Twice is a double tap, not a decision to send it three times.
  if (m.resent_at) return { ok: false, error: "not_resendable" };
  if (!canResend(deliveryNote(m, { connected: true }))) return { ok: false, error: "not_resendable" };

  if (m.status === "failed" && m.error === WA_REASON.noAccount) {
    await c.query(
      `update conversations set on_whatsapp = null, wa_checked_at = null where id = $1 and clinic_id = $2`,
      [opts.conversationId, opts.clinicId]
    );
  }

  const kind = (["image", "video", "document"].includes(m.msg_type) && m.media_path ? m.msg_type : "text") as
    | "text"
    | "image"
    | "video"
    | "document";
  const q = await queueWhatsAppMessage(c, {
    clinicId: opts.clinicId,
    phoneE164: m.phone_e164,
    body: m.body ?? "",
    senderKind: "staff",
    senderUserId: opts.userId,
    msgType: kind,
    mediaPath: kind === "text" ? null : m.media_path,
    mediaName: kind === "text" ? null : m.media_name,
    mediaMime: kind === "text" ? null : m.media_mime,
    mediaMeta: kind === "video" ? m.media_meta : null,
    patientId: m.patient_id,
  });
  await c.query(`update messages set resent_at = now() where id = $1`, [m.id]);
  return { ok: true, messageId: q.messageId };
}
