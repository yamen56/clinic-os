import { withSystem } from "./db";

/**
 * Notice when messages stop arriving.
 *
 * The failure this guards against is not a message that errors — those are
 * visible. It is a message the socket accepts and never delivers: an address
 * that no longer exists, a session that looks connected and is not, a change at
 * WhatsApp's end. Nothing errors, the inbox looks normal, and the clinic finds
 * out when a patient says they never got their appointment reminder. That is
 * how eleven threads in a live clinic went unanswered for days.
 *
 * WhatsApp acknowledges a delivered message within seconds when the recipient's
 * phone is reachable, and within minutes to hours otherwise. So a *run* of
 * messages sent hours ago with not one acknowledgement between them is not a
 * patient with a flat battery — it is the send path being broken again.
 */

/** Ignore anything younger than this: an unacknowledged message is normal at first. */
const GRACE_HOURS = 3;
/** Below this there is no signal, only noise — one silent message proves nothing. */
const MIN_SAMPLE = 5;

export async function deliveryWatch() {
  await withSystem(async (c) => {
    const suspect = await c.query(
      `select m.clinic_id,
              count(*)::int as sent,
              count(*) filter (where m.delivered_at is not null)::int as acked,
              max(m.created_at) as latest
         from messages m
         join whatsapp_sessions ws on ws.clinic_id = m.clinic_id
        where m.direction = 'out'
          and m.status in ('sent', 'delivered', 'read')
          and m.created_at between now() - interval '24 hours'
                              and now() - ($1 || ' hours')::interval
          and ws.status = 'connected'
        group by m.clinic_id
       having count(*) >= $2 and count(*) filter (where m.delivered_at is not null) = 0`,
      [String(GRACE_HOURS), MIN_SAMPLE]
    );

    for (const row of suspect.rows) {
      const clinic = (
        await c.query(`select slug, name, name_ar from clinics where id = $1`, [row.clinic_id])
      ).rows[0];
      if (!clinic) continue;

      /*
        Once per clinic per day. This is a standing condition, not an event —
        repeating it every minute would train everyone to ignore it, which is
        the same as not having it.
      */
      const told = await c.query(
        `select 1 from notifications
          where clinic_id = $1 and kind = 'whatsapp_undelivered'
            and created_at > now() - interval '24 hours'`,
        [row.clinic_id]
      );
      if (told.rowCount) continue;

      const staff = await c.query(
        `select user_id from clinic_members where clinic_id = $1 and is_owner and active
         union select id from users where is_super_admin`,
        [row.clinic_id]
      );
      for (const s of staff.rows) {
        await c.query(
          `insert into notifications (clinic_id, user_id, kind, title, body, url)
           values ($1, $2, 'whatsapp_undelivered', $3, $4, $5)`,
          [
            row.clinic_id,
            s.user_id ?? s.id,
            "الرسائل تُرسَل ولا تصل",
            `أُرسلت ${row.sent} رسالة دون أي إشعار استلام. أعد ربط واتساب، وتحقّق من وصول رسالة تجريبية.`,
            `/c/${clinic.slug}/settings/whatsapp`,
          ]
        );
      }
      console.error(
        `[delivery-watch] ${clinic.slug}: ${row.sent} messages sent, none acknowledged`
      );
    }
  });
}
