import type { BaileysEventMap } from "@whiskeysockets/baileys";
import { withSystem } from "../db";

/**
 * Delivery receipts.
 *
 * WhatsApp reports progress out of band, well after `sendMessage` has already
 * returned: one tick when the server took it, two when the handset has it, and
 * blue when it was opened. Without this the inbox can only ever say "we handed
 * it to the socket", which looks identical for a message that arrived and one
 * that went to a number that has no WhatsApp account.
 */

/** Baileys mirrors proto.WebMessageInfo.Status; PLAYED (5) is a voice note read. */
const BY_CODE: Record<number, "sent" | "delivered" | "read"> = {
  2: "sent", // SERVER_ACK
  3: "delivered", // DELIVERY_ACK
  4: "read", // READ
  5: "read", // PLAYED
};

export async function handleReceipts(
  clinicId: string,
  updates: BaileysEventMap["messages.update"]
) {
  const wanted: { waId: string; status: "sent" | "delivered" | "read" }[] = [];
  const readHere: string[] = [];
  for (const u of updates) {
    const raw = u.update?.status;
    const code = typeof raw === "number" ? raw : Number(raw);
    const status = BY_CODE[code];
    const waId = u.key?.id;
    if (status && waId && u.key?.fromMe) wanted.push({ waId, status });
    // The patient's message, read on the clinic's own phone.
    else if (status === "read" && waId && u.key && !u.key.fromMe) readHere.push(waId);
  }
  if (readHere.length) await readOnThePhone(clinicId, readHere);
  if (!wanted.length) return;

  await withSystem(async (c) => {
    for (const { waId, status } of wanted) {
      /*
        Receipts arrive out of order often enough to matter — a read can land
        before the delivery it implies. Rank the statuses and only ever move
        forward, so a late-arriving 'delivered' cannot un-read a message.
        `array_position` returns null for 'failed' and 'cancelled', which keeps
        a receipt from resurrecting a message we already gave up on.
      */
      await c.query(
        `update messages
            set status = $3,
                delivered_at = case when $3 in ('delivered', 'read')
                                    then coalesce(delivered_at, now()) else delivered_at end,
                read_at = case when $3 = 'read' then coalesce(read_at, now()) else read_at end,
                updated_at = now()
          where clinic_id = $1 and wa_message_id = $2 and direction = 'out'
            and array_position(array['queued','sending','sent','delivered','read'], status)
              < array_position(array['queued','sending','sent','delivered','read'], $3::text)`,
        [clinicId, waId, status]
      );
    }
  });
}

/*
  Read on the clinic's own phone.

  The clinic's WhatsApp is open on a phone at the desk as well as here. When
  somebody reads a patient's messages there, WhatsApp tells every linked device,
  this one included, and the inbox should stop calling them unread rather than
  wait for somebody to open the thread here too (Yamen, 2026-11-07).

  A receipt names the messages read. What is still unread is whatever came in
  after the latest of them; never more than the thread already counted.
*/
async function readOnThePhone(clinicId: string, waIds: string[]) {
  await withSystem(async (c) => {
    await c.query(
      `with seen as (
         select conversation_id, max(created_at) as upto
           from messages
          where clinic_id = $1 and direction = 'in' and wa_message_id = any($2::text[])
          group by conversation_id
       )
       update conversations cv
          set unread_count = least(cv.unread_count, (
                select count(*)::int from messages m
                 where m.conversation_id = cv.id and m.direction = 'in' and m.created_at > seen.upto))
         from seen
        where cv.id = seen.conversation_id and cv.clinic_id = $1 and cv.unread_count > 0`,
      [clinicId, waIds]
    );
  });
}

/**
 * A chat marked read on the phone from its chat list, without opening it. It
 * comes by chat rather than by message: the address is the phone number's or the
 * LID's, so either one of the thread's may be it.
 */
export async function handleChatsRead(clinicId: string, chats: { id?: string | null; unreadCount?: number | null }[]) {
  const users = chats
    .filter((x) => x.unreadCount === 0 && x.id && !x.id.endsWith("@g.us") && !x.id.endsWith("@broadcast"))
    .map((x) => x.id!.split("@")[0].split(":")[0]);
  if (!users.length) return;
  await withSystem(async (c) => {
    await c.query(
      `update conversations set unread_count = 0
        where clinic_id = $1 and unread_count > 0
          and (split_part(split_part(wa_jid, '@', 1), ':', 1) = any($2::text[])
               or split_part(split_part(wa_lid, '@', 1), ':', 1) = any($2::text[]))`,
      [clinicId, users]
    );
  });
}
