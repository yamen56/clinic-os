import type { PoolClient } from "pg";
import { notifyUser } from "../../src/lib/notify";
import { resolveCapabilities, type MemberRole } from "../../src/lib/permissions";
import { maskByFeatures, resolveFeatures } from "../../src/lib/features";
import { patientMessageKey as keyFor } from "../../src/lib/patient-message-alerts";

export { clearPatientMessageAlerts } from "../../src/lib/patient-message-alerts";

/*
  A patient's WhatsApp message, on the phones of the people who answer them.

  Yamen, 2026-11-20: "when someone sends a message on WhatsApp I want to
  receive it so I can reply immediately". The clinic's own phone hears it, but
  the doctor and the desk carry their own phones, and the app only said so in
  a digest at noon.

  One line per conversation and person, replaced by the latest message rather
  than piling up — the team chat's rule (0093): the old line is deleted and a
  new one made, so it pops up and buzzes again like any new message. Reading
  the conversation, in the app or on the clinic's phone, clears it
  (clearPatientMessageAlerts). Each person's "Patients' WhatsApp messages"
  switch decides phone, app only, or nothing.

  To whoever may open the inbox, in this clinic, as their licence masks it —
  the same answer the inbox's own gate gives.
*/

type Msg = { msgType: string; body: string; mediaName: string | null };

const WORDS = {
  ar: {
    image: "📷 صورة",
    video: "🎥 فيديو",
    audio: "🎤 رسالة صوتية",
    document: "📄 ملف",
    sticker: "ملصق",
    location: "📍 موقع",
    unknown: "رسالة",
    someone: "رقم جديد",
    more: (n: number) => `${n} رسائل جديدة`,
  },
  en: {
    image: "📷 Photo",
    video: "🎥 Video",
    audio: "🎤 Voice message",
    document: "📄 File",
    sticker: "Sticker",
    location: "📍 Location",
    unknown: "Message",
    someone: "New number",
    more: (n: number) => `${n} new messages`,
  },
};

function bodyOf(m: Msg, L: (typeof WORDS)["ar"]): string {
  const text = m.body.trim();
  if (m.msgType === "text") return text || L.unknown;
  if (m.msgType === "location") return L.location;
  const what = (L as Record<string, unknown>)[m.msgType];
  const label = typeof what === "string" ? what : L.unknown;
  if (m.msgType === "document" && m.mediaName) return `${label}: ${m.mediaName}`;
  return text ? `${label} · ${text}` : label;
}

export async function alertPatientMessage(c: PoolClient, clinicId: string, conversationId: string, m: Msg): Promise<void> {
  const conv = (
    await c.query(
      `select cv.phone_e164, cv.identifier_kind, cv.whatsapp_name, cv.unread_count, p.full_name as patient_name,
              cl.slug, cl.features, cl.deleted_at, cl.subscription_status
         from conversations cv
         join clinics cl on cl.id = cv.clinic_id
         left join patients p on p.id = cv.patient_id
        where cv.id = $1 and cv.clinic_id = $2`,
      [conversationId, clinicId]
    )
  ).rows[0];
  if (!conv || conv.deleted_at || conv.subscription_status === "suspended") return;
  const features = resolveFeatures(conv.features);
  if (!features.conversations) return;

  const members = (
    await c.query(
      `select cm.user_id, cm.role, cm.is_owner, cm.permissions, coalesce(u.locale, 'ar') as locale
         from clinic_members cm join users u on u.id = cm.user_id
        where cm.clinic_id = $1 and cm.active`,
      [clinicId]
    )
  ).rows as { user_id: string; role: MemberRole; is_owner: boolean; permissions: Record<string, unknown> | null; locale: string }[];

  const url = `/c/${conv.slug}/conversations?open=${conversationId}`;
  const unread = Number(conv.unread_count) || 1;
  for (const member of members) {
    const caps = maskByFeatures(resolveCapabilities(member.permissions, { isOwner: member.is_owner, role: member.role }), features);
    if (!caps.conversations) continue;
    const L = member.locale === "en" ? WORDS.en : WORDS.ar;
    // The patient's name when they have a file; the name on their WhatsApp; the number; never a LID's digits.
    const who =
      (conv.patient_name as string | null) ||
      (conv.whatsapp_name as string | null) ||
      (conv.identifier_kind === "phone" ? (conv.phone_e164 as string) : null) ||
      L.someone;
    const body = bodyOf(m, L);
    // Several waiting: said once, above the latest, so the line still reads as the conversation.
    const shown = unread > 1 ? `${L.more(unread)}\n${body}` : body;
    await c.query(`delete from notifications where dedupe_key = $1`, [`${keyFor(conversationId)}:${member.user_id}`]);
    await notifyUser(c, member.user_id, {
      clinicId,
      kind: "whatsapp_message",
      title: who,
      body: shown,
      url,
      dedupeKey: keyFor(conversationId),
    });
  }
}
