import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { withSystem } from "./db";
import { sessions } from "./wa/session";
import { resolveSendAddress } from "./wa/resolve-address";
import { readFileBuffer } from "../src/lib/storage";
import { notifyUser } from "../src/lib/notify";
import type { AnyMessageContent } from "@whiskeysockets/baileys";

/**
 * Outbound sender with number-protection rails:
 * - randomized 3–10s delay between sends per clinic
 * - daily cap per clinic (overflow deferred to next window)
 * - identical-message blast guard (pauses automation sends)
 * - repeated errors pause the clinic's queue and notify the owner
 */

const nextSendAt = new Map<string, number>(); // clinicId → epoch ms

export function startOutboundLoop() {
  const tick = async () => {
    try {
      await processOnce();
    } catch (e) {
      console.error("[outbound]", (e as Error).message);
    }
    setTimeout(tick, 1500);
  };
  void tick();
}

/**
 * Put back anything left mid-flight.
 *
 * A message is marked 'sending' before the socket is touched, so a worker that
 * restarts — or a failure inside the failure handler — strands it in a state
 * nothing looks at again. Reclaiming after a few minutes costs at worst one
 * duplicate; not reclaiming costs the message.
 */
async function reclaimStranded() {
  const r = await withSystem((c) =>
    c.query(
      `update messages set status = 'queued'
        where status = 'sending' and updated_at < now() - interval '5 minutes'
        returning id`
    )
  );
  if (r.rowCount) console.log(`[outbound] reclaimed ${r.rowCount} stranded message(s)`);
}

/**
 * How often to go looking for stranded messages.
 *
 * It used to run on every outbound tick, which is 1.5 seconds — two hundred
 * times more often than a five-minute threshold can possibly reward. Even with
 * the partial index from migration 0038 that is work nobody asked for, and
 * without it, it was the single most expensive thing the worker did.
 *
 * The cost of the slower cadence is that a stranded message waits up to 5m30s
 * instead of 5m01s. Nothing measures the difference: the message was stranded
 * by a worker that died, and the five minutes is already a guess at "long
 * enough that it is definitely not still in flight".
 */
const RECLAIM_EVERY_MS = 30_000;
let lastReclaim = 0;

export async function processOnce() {
  if (Date.now() - lastReclaim > RECLAIM_EVERY_MS) {
    lastReclaim = Date.now();
    await reclaimStranded().catch((e) =>
      console.error("[outbound] reclaim failed:", (e as Error).message)
    );
  }
  const connected = [...sessions.entries()].filter(([, s]) => s.connected);
  await Promise.all(
    connected.map(async ([clinicId, session]) => {
      if ((nextSendAt.get(clinicId) ?? 0) > Date.now()) return;

      const claimed = await withSystem(async (c) => {
        const ses = (
          await c.query(
            // outbound_date is cast to text deliberately. A `date` comes back
            // from node-pg as a JS Date in the *server's* zone, so comparing it
            // to a clinic-local ISO day was never equal — which silently reset
            // the counter on every send and left the daily cap doing nothing.
            `select ws.paused_until, ws.consecutive_errors, ws.outbound_today,
                    ws.outbound_date::text as outbound_date,
                    cl.daily_outbound_cap, cl.timezone, cl.message_window_start
             from whatsapp_sessions ws join clinics cl on cl.id = ws.clinic_id
             where ws.clinic_id = $1`,
            [clinicId]
          )
        ).rows[0];
        if (!ses) return null;
        if (ses.paused_until && new Date(ses.paused_until) > new Date()) return null;

        const today = DateTime.now().setZone(ses.timezone).toISODate();
        if (ses.outbound_date !== today) {
          await c.query(
            `update whatsapp_sessions set outbound_today = 0, outbound_date = $2 where clinic_id = $1`,
            [clinicId, today]
          );
          ses.outbound_today = 0;
        }

        /*
          Somebody is waiting on a staff reply; nobody is waiting on a
          reminder. Strict arrival order put a receptionist's message behind
          every queued automation — fifty of them at one every six seconds is
          five minutes before their reply leaves, which reads as the product
          being broken while it is working exactly as written.

          The AI counts as interactive for the same reason: it is answering a
          patient who is sitting in the chat right now.
        */
        const row = (
          await c.query(
            `update messages set status = 'sending'
             where id = (
               select id from messages
               where clinic_id = $1 and status = 'queued' and scheduled_at <= now()
               order by case when sender_kind in ('staff', 'ai') then 0 else 1 end,
                        created_at
               limit 1
               for update skip locked
             )
             returning *`,
            [clinicId]
          )
        ).rows[0];
        if (!row) return null;

        // Daily cap: push overflow to the next day's window
        if (ses.outbound_today >= ses.daily_outbound_cap) {
          const nextWindow = DateTime.now()
            .setZone(ses.timezone)
            .plus({ days: 1 })
            .startOf("day")
            .plus({ minutes: hmToMinutes(String(ses.message_window_start)) });
          await c.query(
            `update messages set status = 'queued', scheduled_at = $2 where id = $1`,
            [row.id, nextWindow.toUTC().toISO()]
          );
          console.log(`[outbound ${clinicId}] daily cap reached — deferred message`);
          return null;
        }

        /*
          Blast guard: an automation fanning the same text out to the whole
          patient list, which is the shape of a misconfigured trigger and the
          fastest way to get a number banned.

          The threshold follows the clinic's own daily cap rather than sitting
          at a fixed handful. A busy clinic sending an unpersonalised reminder
          to fifty patients is doing something ordinary — at one message every
          six seconds it used to cross a fixed limit of eight within a minute,
          pause every automation for half an hour, and do it again on the next
          message. That made high volume impossible by accident.

          Campaigns are exempt on purpose — sending one message to many numbers
          is the whole feature, and their protection is upstream: the drip
          releases one recipient per configured interval and stops entirely
          when this clinic is paused, capped, or out of hours.
        */
        if (row.sender_kind === "automation" && row.body) {
          const limit = Math.max(30, Math.floor(Number(ses.daily_outbound_cap) / 5));
          const blast = (
            await c.query(
              `select count(distinct conversation_id)::int as n from messages
               where clinic_id = $1 and body = $2 and created_at > now() - interval '10 minutes'`,
              [clinicId, row.body]
            )
          ).rows[0];
          if (blast.n > limit) {
            await c.query(
              `update whatsapp_sessions set paused_until = now() + interval '30 minutes' where clinic_id = $1`,
              [clinicId]
            );
            await c.query(
              `update messages set status = 'queued', scheduled_at = now() + interval '35 minutes' where id = $1`,
              [row.id]
            );
            // Silently pausing a clinic's automations is how this stayed
            // invisible: nothing sends, nothing errors, nobody is told.
            await notifyBlastGuard(c, clinicId, blast.n);
            console.log(
              `[outbound ${clinicId}] blast guard tripped at ${blast.n} (limit ${limit}) — pausing automations 30m`
            );
            return null;
          }
        }

        const conv = (
          await c.query(
            `select phone_e164, wa_jid, on_whatsapp, wa_checked_at, identifier_kind
               from conversations where id = $1`,
            [row.conversation_id]
          )
        ).rows[0];
        return {
          row,
          phone: conv?.phone_e164 as string,
          waJid: conv?.wa_jid as string | null,
          onWhatsApp: conv?.on_whatsapp as boolean | null,
          checkedAt: conv?.wa_checked_at as Date | null,
          isLid: conv?.identifier_kind === "lid",
        };
      });

      if (!claimed) return;
      const { row, phone } = claimed;

      /*
        Does this number have WhatsApp at all? Sending to one that does not is
        not an error the socket reports — it accepts the message and it simply
        never arrives, which then reads as "sent" forever. Ask once and
        remember: a number that has WhatsApp today still will next month, and
        asking on every send is exactly the repeated lookup that gets a number
        rate-limited.
      */
      const stale =
        !claimed.checkedAt || Date.now() - new Date(claimed.checkedAt).getTime() > 30 * 864e5;
      /*
        The stored address wins. It is the one WhatsApp used when the patient
        wrote to us, so it is known to reach them — where a rebuilt one is a
        guess, and a wrong guess is a message that vanishes without an error.
        Only a conversation we started ourselves has no stored address.
      */
      let jid = claimed.waJid || `${phone.replace("+", "")}@s.whatsapp.net`;

      /*
        A LID cannot be looked up as a number and does not need to be: the
        patient reached us at it, so it is the one address we know works. Both
        the lookup and the verdict below are skipped — asking produced "no such
        account", which is true of the digits and false of the chat, and threw
        away messages that would have been delivered.
      */
      if (!claimed.isLid && (claimed.onWhatsApp === null || stale)) {
        try {
          const addr = await resolveSendAddress(session.sock, phone);
          if (addr.exists === null) {
            console.log(`[outbound ${clinicId}] no verdict for ${phone} — sending anyway`);
          } else {
            if (addr.jid) jid = addr.jid;
            await withSystem((c) =>
              c.query(
                `update conversations set on_whatsapp = $2, wa_checked_at = now(),
                        wa_jid = coalesce($3, wa_jid),
                        wa_lid = coalesce($4, wa_lid)
                  where id = $1`,
                [row.conversation_id, addr.exists, addr.jid, addr.lid]
              )
            );
            claimed.onWhatsApp = addr.exists;
          }
        } catch (e) {
          // A lookup failure is a connection problem, not a verdict on the
          // number. Fall through and let the send itself decide.
          console.error(`[outbound ${clinicId}] onWhatsApp check failed:`, (e as Error).message);
        }
      }

      if (!claimed.isLid && claimed.onWhatsApp === false) {
        await withSystem((c) =>
          c.query(
            `update messages set status = 'failed', error = 'no_whatsapp_account', attempts = attempts + 1
              where id = $1`,
            [row.id]
          )
        );
        console.log(`[outbound ${clinicId}] ${phone} has no WhatsApp account — not sending`);
        return;
      }

      try {
        let content: AnyMessageContent;
        if (row.msg_type === "image" && row.media_path) {
          const buf = await readFileBuffer(row.media_path);
          if (!buf) throw new Error("media file missing");
          content = { image: buf, caption: row.body || undefined };
        } else if (row.msg_type === "document" && row.media_path) {
          const buf = await readFileBuffer(row.media_path);
          if (!buf) throw new Error("media file missing");
          content = {
            document: buf,
            mimetype: row.media_mime ?? "application/octet-stream",
            fileName: row.media_name ?? "document.pdf",
            caption: row.body || undefined,
          };
        } else {
          content = { text: row.body };
        }

        const sent = await session.sock!.sendMessage(jid, content);
        await withSystem(async (c) => {
          await c.query(
            `update messages set status = 'sent', sent_at = now(), wa_message_id = coalesce($2, wa_message_id), error = null
             where id = $1`,
            [row.id, sent?.key?.id ?? null]
          );
          await c.query(
            `update whatsapp_sessions set outbound_today = outbound_today + 1, consecutive_errors = 0, last_seen_at = now()
             where clinic_id = $1`,
            [clinicId]
          );
        });
      } catch (e) {
        const errMsg = (e as Error).message.slice(0, 300);
        console.error(`[outbound ${clinicId}] send failed:`, errMsg);
        await withSystem(async (c) => {
          const attempts = (row.attempts ?? 0) + 1;
          if (attempts < 3) {
            /*
              The casts are load-bearing. Postgres cannot deduce one type for a
              parameter used both as an integer column and as the left side of
              an interval multiply, so this statement threw — which meant the
              retry path itself failed and left the message stuck in 'sending'
              for good: never sent, never failed, and invisible to the failure
              count. Only a send error reaches this code, so nothing exercised
              it until one did.
            */
            await c.query(
              `update messages set status = 'queued', attempts = $2::int, error = $3,
                 scheduled_at = now() + ($2::int * interval '90 seconds')
               where id = $1`,
              [row.id, attempts, errMsg]
            );
          } else {
            await c.query(`update messages set status = 'failed', attempts = $2, error = $3 where id = $1`, [
              row.id,
              attempts,
              errMsg,
            ]);
          }
          const ses = (
            await c.query(
              `update whatsapp_sessions set consecutive_errors = consecutive_errors + 1
               where clinic_id = $1 returning consecutive_errors`,
              [clinicId]
            )
          ).rows[0];
          // Repeated failures: pause automations and alert
          if (ses.consecutive_errors === 5) {
            await c.query(
              `update whatsapp_sessions set paused_until = now() + interval '15 minutes' where clinic_id = $1`,
              [clinicId]
            );
            const clinic = (
              await c.query(`select slug, name, name_ar from clinics where id = $1`, [clinicId])
            ).rows[0];
            const owners = await c.query(
              `select user_id from clinic_members where clinic_id = $1 and is_owner and active`,
              [clinicId]
            );
            // Once an hour: the pause is fifteen minutes, so a number that keeps
            // failing would otherwise raise this four times an hour, for hours.
            const errHour = new Date().toISOString().slice(0, 13);
            for (const o of owners.rows) {
              await notifyUser(c, o.user_id as string, {
                clinicId,
                kind: "whatsapp_errors",
                title: "رسائل واتساب تفشل بشكل متكرر",
                body: "تم إيقاف الإرسال مؤقتاً لمدة 15 دقيقة لحماية الرقم.",
                url: `/c/${clinic.slug}/settings/whatsapp`,
                dedupeKey: `wa_errors:${clinicId}:${errHour}`,
              });
            }
          }
        });
      }

      // Randomized human-like delay before this clinic's next send
      nextSendAt.set(clinicId, Date.now() + 3000 + Math.random() * 7000);
    })
  );
}

/**
 * Tell someone the guard fired. Once an hour: it stays tripped for thirty
 * minutes and the same automation will keep arriving at it, and an alarm that
 * repeats every message is one people learn to click past.
 */
async function notifyBlastGuard(c: PoolClient, clinicId: string, n: number) {
  const told = await c.query(
    `select 1 from notifications
      where clinic_id = $1 and kind = 'whatsapp_blast_guard'
        and created_at > now() - interval '1 hour'`,
    [clinicId]
  );
  if (told.rowCount) return;
  const clinic = (await c.query(`select slug from clinics where id = $1`, [clinicId])).rows[0];
  if (!clinic) return;
  const staff = await c.query(
    `select user_id from clinic_members where clinic_id = $1 and is_owner and active
     union select id from users where is_super_admin`,
    [clinicId]
  );
  for (const s of staff.rows) {
    await c.query(
      `insert into notifications (clinic_id, user_id, kind, title, body, url)
       values ($1, $2, 'whatsapp_blast_guard', $3, $4, $5)`,
      [
        clinicId,
        s.user_id ?? s.id,
        "تم إيقاف الأتمتة مؤقتاً لحماية الرقم",
        `أُرسل النص نفسه إلى ${n} رقماً خلال عشر دقائق. إن كان مقصوداً فاستخدم الحملات، وإلا فراجع الأتمتة.`,
        `/c/${clinic.slug}/settings/whatsapp`,
      ]
    );
  }
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
