import { DateTime } from "luxon";
import { withSystem } from "./db";
import { pushToUser, pushConfigured } from "../src/lib/push";

/**
 * Notification delivery + the scheduled digests.
 *
 * Every in-app notification row is mirrored to web push once (push_sent flag).
 * When push is unavailable for a user, critical alerts fall back to WhatsApp on
 * their own number, per the brief.
 */

const CRITICAL = new Set(["whatsapp_disconnected", "whatsapp_errors", "ai_escalation"]);

/** Mirrors unsent in-app notifications to web push (and WhatsApp for critical ones). */
async function deliverPending() {
  await withSystem(async (c) => {
    const rows = await c.query(
      `select n.id, n.user_id, n.clinic_id, n.kind, n.title, n.body, n.url,
              u.phone_e164, u.notification_prefs
       from notifications n join users u on u.id = n.user_id
       where not n.push_sent and n.created_at > now() - interval '1 day'
       order by n.created_at limit 100`
    );
    for (const n of rows.rows) {
      const prefs = (n.notification_prefs ?? {}) as Record<string, boolean>;
      const prefKey =
        n.kind === "booking" ? "new_booking" :
        n.kind === "doctor_reminder" ? "doctor_reminder" :
        n.kind === "daily_summary" ? "daily_summary" :
        n.kind === "day_end" ? "day_end" :
        n.kind === "unread_digest" ? "unread_digest" : null;
      if (prefKey && prefs[prefKey] === false) {
        await c.query(`update notifications set push_sent = true where id = $1`, [n.id]);
        continue;
      }

      let sent = 0;
      try {
        sent = await pushToUser(c, n.user_id, {
          title: n.title,
          body: n.body,
          url: n.url ?? "/",
          tag: n.kind,
        });
      } catch (e) {
        console.error("[notify] push failed", (e as Error).message);
      }

      // Critical alerts fall back to the staff member's own WhatsApp
      if (sent === 0 && CRITICAL.has(n.kind) && n.phone_e164 && n.clinic_id) {
        const wa = (
          await c.query(
            `select status from whatsapp_sessions where clinic_id = $1 and status = 'connected'`,
            [n.clinic_id]
          )
        ).rows[0];
        if (wa) {
          const conv = await c.query(
            `insert into conversations (clinic_id, phone_e164) values ($1, $2)
             on conflict (clinic_id, phone_e164) do update set clinic_id = excluded.clinic_id
             returning id`,
            [n.clinic_id, n.phone_e164]
          );
          await c.query(
            `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status)
             values ($1, $2, 'out', 'system', 'text', $3, 'queued')`,
            [n.clinic_id, conv.rows[0].id, `${n.title}\n${n.body ?? ""}`.trim()]
          );
        }
      }

      await c.query(`update notifications set push_sent = true where id = $1`, [n.id]);
    }
  });
}

/** Doctor reminders X minutes before each of their appointments. */
async function doctorReminders() {
  await withSystem(async (c) => {
    const due = await c.query(
      `select a.id, a.starts_at, a.clinic_id, cm.user_id, cm.reminder_minutes, cl.slug, cl.timezone,
              p.full_name as patient_name, s.name as service_name, s.name_ar as service_name_ar
       from appointments a
       join clinic_members cm on cm.id = a.doctor_member_id
       join clinics cl on cl.id = a.clinic_id
       join patients p on p.id = a.patient_id
       left join services s on s.id = a.service_id
       where a.status in ('scheduled', 'confirmed')
         and cm.active and cm.reminder_minutes > 0
         and a.starts_at > now()
         and a.starts_at - (cm.reminder_minutes * interval '1 minute') <= now()
         and a.starts_at - (cm.reminder_minutes * interval '1 minute') > now() - interval '90 seconds'
       limit 100`
    );
    for (const r of due.rows) {
      const local = DateTime.fromJSDate(new Date(r.starts_at))
        .setZone(r.timezone)
        .setLocale("ar-JO-u-nu-latn");
      await c.query(
        `insert into notifications (clinic_id, user_id, kind, title, body, url)
         values ($1, $2, 'doctor_reminder', $3, $4, $5)`,
        [
          r.clinic_id,
          r.user_id,
          `موعدك القادم ${local.toFormat("h:mm a")}`,
          `${r.patient_name}${r.service_name ? ` — ${r.service_name_ar || r.service_name}` : ""}`,
          `/c/${r.slug}/calendar`,
        ]
      );
    }
  });
}

/**
 * Claims a digest for one clinic, for one local day.
 *
 * The scheduler ticks every minute and each digest fires inside a three-minute
 * window — `hour === 20 && minute <= 2` — so that a tick arriving a little late,
 * or a worker restarting across the hour, still sends. Without a claim that
 * window means the notification is inserted three times, which is what an owner
 * saw: the same end-of-day summary at 20:00, 20:01 and 20:02.
 *
 * The claim is a `jobs` row with a dedupe key, exactly as the e-sign digest and
 * every automation trigger already do. The unique index decides the winner, so
 * a second worker cannot send it either.
 */
async function claimDailyDigest(
  c: import("pg").PoolClient,
  clinicId: string,
  kind: string,
  localDate: string
): Promise<boolean> {
  const r = await c.query(
    `insert into jobs (clinic_id, kind, payload, status, dedupe_key)
     values ($1, $2, '{}'::jsonb, 'done', $3)
     on conflict (dedupe_key) do nothing
     returning id`,
    [clinicId, `digest:${kind}`, `digest:${kind}:${clinicId}:${localDate}`]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Daily digests: doctor morning schedule, owner end-of-day, staff unread messages. */
async function dailyDigests() {
  await withSystem(async (c) => {
    const clinics = await c.query(
      `select id, slug, name, name_ar, timezone, currency from clinics where subscription_status <> 'suspended'`
    );
    for (const cl of clinics.rows) {
      const now = DateTime.now().setZone(cl.timezone);
      const todayStart = now.startOf("day");
      const todayEnd = todayStart.plus({ days: 1 });

      const today = now.toISODate()!;

      // 08:00 — each doctor's schedule for today
      if (now.hour === 8 && now.minute <= 2 && (await claimDailyDigest(c, cl.id, "morning", today))) {
        const doctors = await c.query(
          `select cm.id, cm.user_id from clinic_members cm
           where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active`,
          [cl.id]
        );
        for (const d of doctors.rows) {
          const appts = await c.query(
            `select count(*)::int as n, min(starts_at) as first from appointments
             where clinic_id = $1 and doctor_member_id = $2
               and starts_at >= $3 and starts_at < $4 and status in ('scheduled', 'confirmed')`,
            [cl.id, d.id, todayStart.toUTC().toISO(), todayEnd.toUTC().toISO()]
          );
          const { n, first } = appts.rows[0];
          if (!n) continue;
          const firstLocal = DateTime.fromJSDate(new Date(first))
            .setZone(cl.timezone)
            .setLocale("ar-JO-u-nu-latn");
          await c.query(
            `insert into notifications (clinic_id, user_id, kind, title, body, url)
             values ($1, $2, 'daily_summary', $3, $4, $5)`,
            [
              cl.id, d.user_id,
              `جدول اليوم: ${n} ${n === 1 ? "موعد" : "مواعيد"}`,
              `أول موعد الساعة ${firstLocal.toFormat("h:mm a")}`,
              `/c/${cl.slug}/calendar`,
            ]
          );
        }
      }

      // 20:00 — owner end-of-day summary
      if (now.hour === 20 && now.minute <= 2 && (await claimDailyDigest(c, cl.id, "day_end", today))) {
        const owners = await c.query(
          `select user_id from clinic_members where clinic_id = $1 and is_owner and active`,
          [cl.id]
        );
        const [stats] = (
          await c.query(
            `select
               (select count(*) from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'completed')::int as completed,
               (select count(*) from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'no_show')::int as no_show,
               (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $2 and paid_at < $3) as revenue`,
            [cl.id, todayStart.toUTC().toISO(), todayEnd.toUTC().toISO()]
          )
        ).rows;
        if (stats.completed || stats.no_show || Number(stats.revenue) > 0) {
          for (const o of owners.rows) {
            await c.query(
              `insert into notifications (clinic_id, user_id, kind, title, body, url)
               values ($1, $2, 'day_end', $3, $4, $5)`,
              [
                cl.id, o.user_id,
                "ملخص اليوم",
                `${stats.completed} موعد مكتمل · ${stats.no_show} لم يحضر · ${Number(stats.revenue).toFixed(2)} ${cl.currency}`,
                `/c/${cl.slug}`,
              ]
            );
          }
        }
      }

      // 12:00 — unread WhatsApp digest for staff
      if (now.hour === 12 && now.minute <= 2 && (await claimDailyDigest(c, cl.id, "unread", today))) {
        const unread = (
          await c.query(
            `select coalesce(sum(unread_count), 0)::int as n from conversations where clinic_id = $1`,
            [cl.id]
          )
        ).rows[0].n;
        if (unread >= 3) {
          const staff = await c.query(
            `select user_id from clinic_members where clinic_id = $1 and active and (is_owner or role = 'receptionist')`,
            [cl.id]
          );
          for (const s of staff.rows) {
            await c.query(
              `insert into notifications (clinic_id, user_id, kind, title, body, url)
               values ($1, $2, 'unread_digest', $3, $4, $5)`,
              [cl.id, s.user_id, `${unread} رسالة غير مقروءة`, "محادثات بانتظار الرد", `/c/${cl.slug}/conversations`]
            );
          }
        }
      }
    }
  });
}

export function startNotificationLoop() {
  const fast = async () => {
    try {
      await deliverPending();
    } catch (e) {
      console.error("[notify]", (e as Error).message);
    }
    setTimeout(fast, 5000);
  };
  const slow = async () => {
    for (const fn of [doctorReminders, dailyDigests]) {
      try {
        await fn();
      } catch (e) {
        console.error(`[notify ${fn.name}]`, (e as Error).message);
      }
    }
    setTimeout(slow, 60_000);
  };
  void fast();
  void slow();
  console.log(`[worker] notifications ready (push ${pushConfigured() ? "enabled" : "disabled — no VAPID keys"})`);
}
