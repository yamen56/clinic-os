import type { BaileysEventMap } from "@whiskeysockets/baileys";
import type { PoolClient } from "pg";
import { withSystem } from "../db";
import { notifyUser } from "../../src/lib/notify";
import { WA_REASON } from "../../src/lib/wa-delivery";

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
  const rejected: { waId: string; code: string }[] = [];
  const readHere: string[] = [];
  for (const u of updates) {
    const raw = u.update?.status;
    const waId = u.key?.id;
    /*
      WhatsApp's server refused the message (Baileys turns the error ack into
      status ERROR, 0, with the server's code first in messageStubParameters).
      This used to fall through the table below, so a refused message kept its
      single grey tick for ever — indistinguishable from one on its way. Compared
      exactly, never through Number(): an update carrying `status: null` is not
      an error.
    */
    if ((raw === 0 || raw === ("ERROR" as never)) && waId && u.key?.fromMe) {
      const param = u.update?.messageStubParameters?.[0];
      rejected.push({ waId, code: String(param ?? "unknown").slice(0, 20) });
      continue;
    }
    const code = typeof raw === "number" ? raw : Number(raw);
    const status = BY_CODE[code];
    if (status && waId && u.key?.fromMe) wanted.push({ waId, status });
    // The patient's message, read on the clinic's own phone.
    else if (status === "read" && waId && u.key && !u.key.fromMe) readHere.push(waId);
  }
  if (readHere.length) await readOnThePhone(clinicId, readHere);
  if (rejected.length) await recordRejections(clinicId, rejected);
  if (!wanted.length) return;

  await withSystem(async (c) => {
    for (const { waId, status } of wanted) {
      /*
        Receipts arrive out of order often enough to matter — a read can land
        before the delivery it implies. Rank the statuses and only ever move
        forward, so a late-arriving 'delivered' cannot un-read a message.
        `array_position` returns null for 'failed' and 'cancelled', which keeps
        a plain server ack from resurrecting a message we already gave up on.

        Delivered and read are the exception: they are the phone itself saying
        the message is there. A message WhatsApp refused and then delivered
        anyway (a retry to a newer device) did arrive, and the inbox should say
        so rather than keep showing the refusal.
      */
      await c.query(
        `update messages
            set status = $3,
                error = case when status = 'failed' then null else error end,
                delivered_at = case when $3 in ('delivered', 'read')
                                    then coalesce(delivered_at, now()) else delivered_at end,
                read_at = case when $3 = 'read' then coalesce(read_at, now()) else read_at end,
                updated_at = now()
          where clinic_id = $1 and wa_message_id = $2 and direction = 'out'
            and (array_position(array['queued','sending','sent','delivered','read'], status)
                   < array_position(array['queued','sending','sent','delivered','read'], $3::text)
                 or (status = 'failed' and $3 in ('delivered', 'read')))`,
        [clinicId, waId, status]
      );
    }
  });
}

/**
 * Messages WhatsApp refused, failed with its code so the inbox can say why.
 *
 * Only while still at 'sent': a message already delivered or read reached the
 * phone whatever an ack said about one of its copies.
 *
 * 463 is about the clinic's number, not the patient: WhatsApp is not letting it
 * start new chats (no privacy token), which is what a number looks like on its
 * way to a ban. Chats where the patient wrote first still work. Retrying is
 * exactly the wrong thing — Baileys says so too — so nothing here retries; the
 * owner is told once a day instead.
 */
async function recordRejections(clinicId: string, rejected: { waId: string; code: string }[]) {
  await withSystem(async (c) => {
    let restricted = 0;
    for (const { waId, code } of rejected) {
      const r = await c.query(
        `update messages set status = 'failed', error = $3, updated_at = now()
          where clinic_id = $1 and wa_message_id = $2 and direction = 'out'
            and status in ('sending', 'sent')
          returning id`,
        [clinicId, waId, WA_REASON.rejected(code)]
      );
      if (r.rowCount) {
        console.error(`[wa ${clinicId}] WhatsApp refused message ${waId} (code ${code})`);
        if (code === "463") restricted += r.rowCount;
      }
    }
    if (restricted) await notifyRestricted(c, clinicId);
  });
}

async function notifyRestricted(c: PoolClient, clinicId: string) {
  const clinic = (await c.query(`select slug from clinics where id = $1`, [clinicId])).rows[0];
  if (!clinic) return;
  const staff = await c.query(
    `select user_id from clinic_members where clinic_id = $1 and is_owner and active
     union select id from users where is_super_admin`,
    [clinicId]
  );
  const day = new Date().toISOString().slice(0, 10);
  for (const s of staff.rows) {
    await notifyUser(c, (s.user_id ?? s.id) as string, {
      clinicId,
      kind: "whatsapp_restricted",
      title: "واتساب يمنع الرقم من بدء محادثات جديدة",
      body: "رسائل إلى أرقام لم تراسل العيادة من قبل تُرفض الآن. المحادثات القائمة تعمل. خفّف الإرسال إلى أرقام جديدة ليوم على الأقل.",
      url: `/c/${clinic.slug}/settings/whatsapp`,
      dedupeKey: `wa_restricted:${clinicId}:${day}`,
    });
  }
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
    // Read there, so the app has nothing left to tell WhatsApp about them (wa:read).
    await c.query(
      `update messages m set read_at = now()
         from (select conversation_id, max(created_at) as upto from messages
                where clinic_id = $1 and direction = 'in' and wa_message_id = any($2::text[]) group by conversation_id) seen
        where m.conversation_id = seen.conversation_id and m.direction = 'in' and m.created_at <= seen.upto and m.read_at is null`,
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
      `with done as (
         update conversations set unread_count = 0
          where clinic_id = $1 and unread_count > 0
            and (split_part(split_part(wa_jid, '@', 1), ':', 1) = any($2::text[])
                 or split_part(split_part(wa_lid, '@', 1), ':', 1) = any($2::text[]))
          returning id)
       update messages set read_at = now()
        where conversation_id in (select id from done) and direction = 'in' and read_at is null`,
      [clinicId, users]
    );
  });
}
