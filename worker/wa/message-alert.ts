import type { PoolClient } from "pg";
import { notifyUser } from "../../src/lib/notify";
import { resolveCapabilities, type MemberRole } from "../../src/lib/permissions";
import { maskByFeatures, resolveFeatures } from "../../src/lib/features";
import { patientMessageKey as keyFor } from "../../src/lib/patient-message-alerts";
import { normalizeStepConfig } from "../../src/lib/automation/catalog";
import { replyHandle } from "../../src/lib/automation/match";

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

  Who hears it is the clinic's "A patient writes on WhatsApp" team alert
  (0111), the way every other alert is:
    owner         the owner, whose licence opens the inbox;
    receptionist  whoever else answers the inbox;
    doctor        each doctor, for their own patients — the doctor of the
                  patient's next visit, else of their last, or the one the
                  conversation is assigned to — and every message for a doctor
                  who answers the inbox too (Yamen, 2026-11-21: "notify the
                  doctor … so they can notify the team and respond
                  immediately, and of course it should be optional").
  A doctor who cannot open the inbox is taken to the team chat, to tell the
  desk; everyone else to the conversation.

  Not for a reply an automation has already dealt with: the "1" that confirms
  tomorrow's appointment, the "1" that books the recall. That was every
  confirmation buzzing the whole desk for nothing, and a reply the flow went on
  to act on — "2, I need to change it" — then told them a second time in the
  flow's own words. A reply it could not read still comes here; so does a
  longer one that happens to contain the answer, which somebody should read.
*/

/** How long a reply can be and still be only the answer it matched. */
const SHORT_ANSWER = { words: 3, chars: 24 };

async function answeredByAutomation(
  c: PoolClient,
  clinicId: string,
  conv: { id: string; patient_id: string | null; phone_e164: string | null },
  m: Msg
): Promise<boolean> {
  const text = m.body.trim();
  if (m.msgType !== "text" || !text) return false;
  if (text.length > SHORT_ANSWER.chars || text.split(/\s+/).length > SHORT_ANSWER.words) return false;
  // The run resumeOnReply will wake for this message: the newest waiting on this thread, patient or number.
  const w = (
    await c.query(
      `select s.config from automation_runs r join automation_steps s on s.id = r.current_step_id
        where r.clinic_id = $1 and r.status = 'waiting' and r.waiting_for = 'reply'
          and (r.conversation_id = $2
               or (r.patient_id is not null and r.patient_id = $3)
               or ($4::text is not null and r.patient_id in (
                     select p.id from patients p where p.clinic_id = $1 and p.phone_e164 = $4 and p.merged_into is null)))
        order by (r.context->>'waiting_since')::timestamptz desc nulls last, r.updated_at desc
        limit 1`,
      [clinicId, conv.id, conv.patient_id, conv.phone_e164]
    )
  ).rows[0];
  if (!w) return false;
  const options = (normalizeStepConfig("wait_for_reply", w.config ?? {}).options as { keywords: string[] }[]) ?? [];
  return replyHandle(text, options).startsWith("opt:");
}

/** The patient's own doctor: of their next visit, else of their last; and whoever the thread is assigned to. */
async function patientDoctors(c: PoolClient, clinicId: string, patientId: string | null, assignedTo: string | null): Promise<Set<string>> {
  const out = new Set<string>();
  if (assignedTo) out.add(assignedTo);
  if (!patientId) return out;
  const r = await c.query(
    `select cm.user_id from (
       (select a.doctor_member_id, 0 as pri from appointments a
         where a.patient_id = $1 and a.clinic_id = $2 and a.doctor_member_id is not null
           and a.starts_at > now() and a.status in ('pending_approval', 'scheduled', 'confirmed')
         order by a.starts_at limit 1)
       union all
       (select a.doctor_member_id, 1 as pri from appointments a
         where a.patient_id = $1 and a.clinic_id = $2 and a.doctor_member_id is not null
           and a.starts_at <= now() and a.status <> 'cancelled'
         order by a.starts_at desc limit 1)
     ) x join clinic_members cm on cm.id = x.doctor_member_id and cm.active
     order by x.pri limit 1`,
    [patientId, clinicId]
  );
  for (const row of r.rows) out.add(row.user_id as string);
  return out;
}

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
      `select cv.id, cv.patient_id, cv.assigned_to, cv.phone_e164, cv.identifier_kind, cv.whatsapp_name, cv.unread_count, p.full_name as patient_name,
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

  const alerts = await c.query(`select roles from clinic_staff_alerts where clinic_id = $1 and kind = 'patient_message' and enabled`, [clinicId]);
  const roles = new Set<string>(alerts.rows.flatMap((r) => (r.roles ?? []) as string[]));
  if (!roles.size) return;
  if (await answeredByAutomation(c, clinicId, conv, m)) return;
  const own = roles.has("doctor") ? await patientDoctors(c, clinicId, conv.patient_id, conv.assigned_to) : new Set<string>();

  const members = (
    await c.query(
      `select cm.user_id, cm.role, cm.is_owner, cm.permissions, coalesce(u.locale, 'ar') as locale
         from clinic_members cm join users u on u.id = cm.user_id
        where cm.clinic_id = $1 and cm.active`,
      [clinicId]
    )
  ).rows as { user_id: string; role: MemberRole; is_owner: boolean; permissions: Record<string, unknown> | null; locale: string }[];

  const inboxUrl = `/c/${conv.slug}/conversations?open=${conversationId}`;
  const teamUrl = `/c/${conv.slug}/conversations/team`;
  const unread = Number(conv.unread_count) || 1;
  for (const member of members) {
    const caps = maskByFeatures(resolveCapabilities(member.permissions, { isOwner: member.is_owner, role: member.role }), features);
    const inbox = caps.conversations === true;
    const wanted =
      (member.is_owner && roles.has("owner") && inbox) ||
      (member.role === "doctor" && roles.has("doctor") && (inbox || own.has(member.user_id))) ||
      (!member.is_owner && member.role !== "doctor" && roles.has("receptionist") && inbox);
    if (!wanted) continue;
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
      // A doctor who cannot open the inbox can still tell the desk, from the team chat.
      url: inbox ? inboxUrl : teamUrl,
      dedupeKey: keyFor(conversationId),
    });
  }
}
