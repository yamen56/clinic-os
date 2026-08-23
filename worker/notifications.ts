import { DateTime } from "luxon";
import { withSystem } from "./db";
import { pushToUser, pushConfigured } from "../src/lib/push";
import { notifyUser, staffInRoles, staffMembersInRoles } from "../src/lib/notify";

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

/**
 * Reminders before an appointment, one pass per configured alert.
 *
 * The lead time used to be each doctor's personal `reminder_minutes` and
 * nothing else. It still is, for the alert every clinic starts with — that row
 * carries `minutes_before = null`, which means "whatever each person set for
 * themselves", so nobody's preference was taken away by making this
 * configurable. A row with a number overrides it clinic-wide, which is how a
 * clinic adds a second, earlier nudge without touching anyone's settings.
 */
export async function doctorReminders() {
  await withSystem(async (c) => {
    const alerts = await c.query(
      `select id, clinic_id, roles, minutes_before from clinic_staff_alerts
       where kind = 'appointment_reminder' and enabled`
    );
    for (const alert of alerts.rows) {
      const lead = alert.minutes_before as number | null;
      const due = await c.query(
        `select a.id, a.starts_at, a.clinic_id, cm.user_id, cl.slug, cl.timezone,
                p.full_name as patient_name, s.name as service_name, s.name_ar as service_name_ar
         from appointments a
         join clinic_members cm on cm.id = a.doctor_member_id
         join clinics cl on cl.id = a.clinic_id
         join patients p on p.id = a.patient_id
         left join services s on s.id = a.service_id
         where a.clinic_id = $1
           and a.status in ('scheduled', 'confirmed')
           and cm.active
           and coalesce($2::int, cm.reminder_minutes) > 0
           and a.starts_at > now()
           and a.starts_at - (coalesce($2::int, cm.reminder_minutes) * interval '1 minute') <= now()
           and a.starts_at - (coalesce($2::int, cm.reminder_minutes) * interval '1 minute') > now() - interval '90 seconds'
         limit 100`,
        [alert.clinic_id, lead]
      );
      if (!due.rowCount) continue;

      const roles = (alert.roles ?? []) as string[];
      // 'doctor' here means the appointment's own doctor, not every doctor in
      // the clinic — which is why it is handled separately from the rest.
      const alsoTell = roles.filter((r) => r !== "doctor");
      const extra = alsoTell.length
        ? await staffInRoles(c, alert.clinic_id as string, alsoTell)
        : [];

      for (const r of due.rows) {
        const local = DateTime.fromJSDate(new Date(r.starts_at))
          .setZone(r.timezone)
          .setLocale("ar-JO-u-nu-latn");
        /*
          Keyed by the appointment, because the window this selects on is ninety
          seconds wide and the scheduler ticks every sixty. Consecutive ticks
          therefore overlap by thirty seconds, and any reminder whose moment fell
          in that overlap was sent twice — about half of them.

          The window is deliberately wider than the tick so a late or restarted
          worker still sends the reminder at all. Narrowing it would trade
          duplicates for silence; the key keeps both.

          The alert id joins the key only for a row with its own lead time. The
          personal-setting row keeps the original key, so a reminder that had
          already gone out when this shipped was not sent a second time.
        */
        const dedupeKey =
          lead === null ? `doctor_reminder:${r.id}` : `doctor_reminder:${alert.id}:${r.id}`;
        const notice = {
          clinicId: r.clinic_id as string,
          kind: "doctor_reminder",
          title: `موعدك القادم ${local.toFormat("h:mm a")}`,
          body: `${r.patient_name}${r.service_name ? ` — ${r.service_name_ar || r.service_name}` : ""}`,
          url: `/c/${r.slug}/calendar`,
          dedupeKey,
        };
        if (roles.includes("doctor")) await notifyUser(c, r.user_id as string, notice);
        for (const uid of extra) {
          if (uid === r.user_id) continue;
          await notifyUser(c, uid, { ...notice, title: `موعد قادم ${local.toFormat("h:mm a")}` });
        }
      }
    }
  });
}

/**
 * Claims a digest for one alert, for one local day.
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
 *
 * Keyed by the alert rather than by the clinic and kind, because a clinic may
 * now have two of the same kind at two different hours and those are two
 * different digests. Migration 0033 pre-claims today's key for every alert whose
 * clinic had already had that digest under the old key, so the day this shipped
 * nobody was told twice.
 */
async function claimDailyDigest(
  c: import("pg").PoolClient,
  clinicId: string,
  kind: string,
  alertId: string,
  localDate: string
): Promise<boolean> {
  const r = await c.query(
    `insert into jobs (clinic_id, kind, payload, status, dedupe_key)
     values ($1, $2, '{}'::jsonb, 'done', $3)
     on conflict (dedupe_key) do nothing
     returning id`,
    [clinicId, `digest:${kind}`, `digest:${kind}:${alertId}:${localDate}`]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The scheduled digests, driven by the clinic's own alert rows.
 *
 * Nothing here decides *whether* a clinic gets a morning list or an end-of-day
 * summary any more, or at what hour, or who reads it — that is four rows the
 * clinic can see and change on its automations page. This decides what each one
 * says.
 */
export async function dailyDigests() {
  await withSystem(async (c) => {
    const alerts = await c.query(
      `select a.id, a.clinic_id, a.kind, a.roles, a.at_hour, a.threshold,
              cl.slug, cl.timezone, cl.currency
       from clinic_staff_alerts a
       join clinics cl on cl.id = a.clinic_id
       where a.enabled and a.kind <> 'appointment_reminder'
         and cl.subscription_status <> 'suspended' and cl.deleted_at is null
       order by a.clinic_id, a.sort`
    );

    for (const alert of alerts.rows) {
      const now = DateTime.now().setZone(alert.timezone);
      // Three minutes wide, so a tick arriving late or a worker restarting
      // across the hour still sends. The claim below is what stops that width
      // turning into three copies.
      if (now.hour !== (alert.at_hour ?? 8) || now.minute > 2) continue;
      const today = now.toISODate()!;
      if (!(await claimDailyDigest(c, alert.clinic_id, alert.kind, alert.id, today))) continue;
      await sendDigest(c, alert as DigestAlert, now);
    }
  });
}

export type DigestAlert = {
  id: string;
  clinic_id: string;
  kind: string;
  roles: string[];
  at_hour: number | null;
  threshold: number;
  slug: string;
  timezone: string;
  currency: string;
};

/**
 * One digest, for one alert, at one moment.
 *
 * Split out from the loop above so that *when* a digest fires and *what it
 * says* can be reasoned about — and tested — separately. The caller owns the
 * clock and the claim; this owns the audience and the wording.
 */
export async function sendDigest(
  c: import("pg").PoolClient,
  alert: DigestAlert,
  now: DateTime
): Promise<void> {
  const today = now.toISODate()!;
  const todayStart = now.startOf("day");
  const todayEnd = todayStart.plus({ days: 1 });
  const roles = (alert.roles ?? []) as string[];
  if (!roles.length) return;

  if (alert.kind === "day_schedule") {
    /*
      A doctor is sent their own list; anyone else on the alert is sent the
      clinic's. Reception asking "how busy are we today" and a doctor asking
      "what have I got" are the same question about different rows, and
      answering both with the doctor's list would make the alert useless to
      half the people receiving it.
    */
    for (const m of await staffMembersInRoles(c, alert.clinic_id, roles)) {
      const own = m.role === "doctor";
      const appts = await c.query(
        `select count(*)::int as n, min(starts_at) as first from appointments
         where clinic_id = $1 and ($2::uuid is null or doctor_member_id = $2)
           and starts_at >= $3 and starts_at < $4 and status in ('scheduled', 'confirmed')`,
        [
          alert.clinic_id,
          own ? m.memberId : null,
          todayStart.toUTC().toISO(),
          todayEnd.toUTC().toISO(),
        ]
      );
      const { n, first } = appts.rows[0];
      if (!n) continue;
      const firstLocal = DateTime.fromJSDate(new Date(first))
        .setZone(alert.timezone)
        .setLocale("ar-JO-u-nu-latn");
      await notifyUser(c, m.userId, {
        clinicId: alert.clinic_id,
        kind: "daily_summary",
        title: `${own ? "جدول اليوم" : "مواعيد العيادة اليوم"}: ${n} ${n === 1 ? "موعد" : "مواعيد"}`,
        body: `أول موعد الساعة ${firstLocal.toFormat("h:mm a")}`,
        url: `/c/${alert.slug}/calendar`,
        dedupeKey: `daily_summary:${alert.id}:${today}`,
      });
    }
  } else if (alert.kind === "day_end") {
    const [stats] = (
      await c.query(
        `select
           (select count(*) from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'completed')::int as completed,
           (select count(*) from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'no_show')::int as no_show,
           (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $2 and paid_at < $3) as revenue`,
        [alert.clinic_id, todayStart.toUTC().toISO(), todayEnd.toUTC().toISO()]
      )
    ).rows;
    // A day with nothing in it is not news, and an empty summary every
    // evening is how a clinic learns to ignore the whole channel.
    if (!stats.completed && !stats.no_show && Number(stats.revenue) <= 0) return;
    for (const uid of await staffInRoles(c, alert.clinic_id, roles)) {
      await notifyUser(c, uid, {
        clinicId: alert.clinic_id,
        kind: "day_end",
        title: "ملخص اليوم",
        body: `${stats.completed} موعد مكتمل · ${stats.no_show} لم يحضر · ${Number(stats.revenue).toFixed(2)} ${alert.currency}`,
        url: `/c/${alert.slug}`,
        dedupeKey: `day_end:${alert.id}:${today}`,
      });
    }
  } else if (alert.kind === "unread_digest") {
    const unread = (
      await c.query(
        `select coalesce(sum(unread_count), 0)::int as n from conversations where clinic_id = $1`,
        [alert.clinic_id]
      )
    ).rows[0].n as number;
    if (unread < (alert.threshold ?? 0)) return;
    for (const uid of await staffInRoles(c, alert.clinic_id, roles)) {
      await notifyUser(c, uid, {
        clinicId: alert.clinic_id,
        kind: "unread_digest",
        title: `${unread} رسالة غير مقروءة`,
        body: "محادثات بانتظار الرد",
        url: `/c/${alert.slug}/conversations`,
        dedupeKey: `unread_digest:${alert.id}:${today}`,
      });
    }
  }
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
