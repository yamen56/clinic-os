import { withSystem } from "../db";
import { registerJobHandler } from "../jobs";
import { sessions } from "./session";

/**
 * Read in the app is read on WhatsApp (Yamen, 2026-11-07).
 *
 * Opening a thread in the inbox, or answering it, queues `wa:read`. Here the
 * patient's unread messages are marked read through the clinic's socket, the
 * same receipt the clinic's phone sends when somebody reads them there: the
 * phone's own chat stops showing them as new, and the patient sees blue ticks
 * if, and only if, the clinic's phone has read receipts switched on. Baileys
 * sends "read-self" otherwise, which tells the clinic's own devices and nobody
 * else, so the phone's privacy setting stays the one that decides.
 *
 * Each message is answered once (`read_at`), on the chat it arrived on. Only the
 * last week's: a receipt for something months old tells nobody anything.
 */
export function registerReadJobs() {
  registerJobHandler("wa:read", sendReadReceipts);
}

export async function sendReadReceipts(payload: Record<string, unknown>, clinicId: string | null) {
  const conversationId = String(payload.conversationId ?? "");
  if (!clinicId || !conversationId) return;
  const sock = sessions.get(clinicId)?.sock;
  // Not connected: nothing to tell, and the phone shows them unread as it always did.
  if (!sock?.user) return;

  const rows = await withSystem(async (c) =>
    (
      await c.query(
        `select m.id, m.wa_message_id, coalesce(m.wa_remote_jid, cv.wa_jid) as jid
           from messages m join conversations cv on cv.id = m.conversation_id
          where m.conversation_id = $1 and m.clinic_id = $2 and m.direction = 'in'
            and m.wa_message_id is not null and m.read_at is null
            and m.created_at > now() - interval '7 days'
          order by m.created_at desc
          limit 100`,
        [conversationId, clinicId]
      )
    ).rows as { id: string; wa_message_id: string; jid: string | null }[]
  );
  if (!rows.length) return;
  const keys = rows.filter((r) => r.jid).map((r) => ({ remoteJid: r.jid!, id: r.wa_message_id, fromMe: false }));
  if (keys.length) await sock.readMessages(keys);
  // All of them, the addressless too: there is nothing more to tell about any, and no reason to ask again.
  await withSystem((c) => c.query(`update messages set read_at = now() where id = any($1::uuid[])`, [rows.map((r) => r.id)]));
}
