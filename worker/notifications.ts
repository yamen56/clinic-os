import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { withSystem } from "./db";
import { pushToUser, pushConfigured } from "../src/lib/push";
import { notifyUser, staffMembersInRoles, type StaffMember } from "../src/lib/notify";
import { resolveCapabilities, type CapabilityMap, type MemberRole } from "../src/lib/permissions";
import {
  WHATSAPP_FALLBACK,
  deliveryFor,
  levelOf,
  parseQuiet,
  prefKeyFor,
  quietUntil,
} from "../src/lib/notification-kinds";
import { NT, asLocale, clock, when, type NLocale } from "../src/lib/notification-text";

/**
 * Notification delivery + the scheduled digests + the instant appointment alerts.
 *
 * Every in-app notification row is mirrored to web push once (push_sent flag).
 * When push is unavailable for a user, critical alerts fall back to WhatsApp on
 * their own number, per the brief.
 */

/** Summaries: a newer one replaces the older on the lock screen instead of piling up. */
const REPLACEABLE = new Set([
  "daily_summary",
  "tomorrow_schedule",
  "unconfirmed_tomorrow",
  "day_end",
  "weekly_summary",
  "unread_digest",
  "document_digest",
]);

const ARABIC = /[؀-ۿ]/;

export type Pending = {
  id: string;
  user_id: string;
  clinic_id: string | null;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  read_at: string | null;
  push_after: string | null;
  phone_e164: string | null;
  notification_prefs: Record<string, unknown> | null;
  locale: string;
  tz: string;
  slug: string | null;
};

async function unreadCount(c: PoolClient, userId: string): Promise<number> {
  return (
    await c.query(`select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [
      userId,
    ])
  ).rows[0].n as number;
}

async function markPushed(c: PoolClient, ids: string[]) {
  if (ids.length) await c.query(`update notifications set push_sent = true where id = any($1::uuid[])`, [ids]);
}

/**
 * Mirrors unsent in-app notifications to web push (and WhatsApp for critical ones).
 *
 * The row is in the app the instant it is written — the realtime stream puts it
 * on every open screen. This decides only what reaches the phone, and when:
 *
 *   * a kind the person keeps "in the app only" never does;
 *   * something they already read in the app is not pushed after the fact;
 *   * inside their quiet hours it waits for the morning (`push_after`), unless
 *     it is urgent and they let urgent things through — and a reminder, which
 *     is worthless late, is not held at all;
 *   * what was held comes out as one summary, not a burst of twelve buzzes.
 */
export type DeliveryPlan = {
  /** Never going to the phone: read already, kept in the app, or stale by the time quiet hours end. */
  skip: string[];
  /** Inside the person's quiet hours: wait until then. */
  hold: { id: string; until: string }[];
  /** Out now, one push each. */
  push: Pending[];
  /** Released from quiet hours together, per person: one summary push for all of them. */
  summaries: Map<string, Pending[]>;
};

/**
 * What to do with each pending row — decided without touching the network or
 * the database, so every rule above can be tested exactly, at any hour.
 */
export function planDelivery(rows: Pending[], now: Date = new Date()): DeliveryPlan {
  const plan: DeliveryPlan = { skip: [], hold: [], push: [], summaries: new Map() };
  const released = new Map<string, Pending[]>();

  for (const n of rows) {
    const prefs = n.notification_prefs ?? {};
    if (n.read_at || levelOf(prefs, prefKeyFor(n.kind)) !== "push") {
      plan.skip.push(n.id);
      continue;
    }
    if (n.push_after) {
      const list = released.get(n.user_id) ?? [];
      list.push(n);
      released.set(n.user_id, list);
      continue;
    }
    const d = deliveryFor(n.kind);
    const q = parseQuiet(prefs.quiet);
    const until = quietUntil(q, DateTime.fromJSDate(now).setZone(n.tz));
    const breaksThrough = n.kind === "test" || (d.urgent && q.urgent);
    if (until && !breaksThrough) {
      if (d.dropWhenQuiet) plan.skip.push(n.id);
      else plan.hold.push({ id: n.id, until: until.toUTC().toISO()! });
      continue;
    }
    plan.push.push(n);
  }

  for (const [userId, list] of released) {
    if (list.length === 1) plan.push.push(list[0]);
    else plan.summaries.set(userId, list);
  }
  return plan;
}

export async function deliverPending() {
  await withSystem(async (c) => {
    const rows = (
      await c.query(
        `select n.id, n.user_id, n.clinic_id, n.kind, n.title, n.body, n.url, n.read_at, n.push_after,
                u.phone_e164, u.notification_prefs, u.locale,
                coalesce(cl.timezone, 'Asia/Amman') as tz, cl.slug
           from notifications n
           join users u on u.id = n.user_id
           left join clinics cl on cl.id = n.clinic_id
          where not n.push_sent
            and coalesce(n.push_after, n.created_at) <= now()
            and coalesce(n.push_after, n.created_at) > now() - interval '1 day'
          order by n.created_at limit 100`
      )
    ).rows as Pending[];

    const plan = planDelivery(rows);
    await markPushed(c, plan.skip);
    for (const h of plan.hold) {
      await c.query(`update notifications set push_after = $2 where id = $1`, [h.id, h.until]);
    }
    for (const n of plan.push) await pushOne(c, n);

    for (const [userId, list] of plan.summaries) {
      const L = NT[asLocale(list[0].locale)];
      const slug = list.find((x) => x.slug)?.slug;
      try {
        await pushToUser(
          c,
          userId,
          {
            title: L.heldTitle(list.length),
            body: L.heldBody,
            url: slug ? `/c/${slug}/notifications` : "/",
            tag: "held",
            lang: asLocale(list[0].locale),
            badge: await unreadCount(c, userId),
          },
          { urgency: "normal", ttl: 3 * 3600 }
        );
      } catch (e) {
        console.error("[notify] push failed", (e as Error).message);
      }
      await markPushed(
        c,
        list.map((x) => x.id)
      );
    }
  });
}

async function pushOne(c: PoolClient, n: Pending) {
  const d = deliveryFor(n.kind);
  let sent = 0;
  try {
    sent = await pushToUser(
      c,
      n.user_id,
      {
        title: n.title,
        body: n.body,
        url: n.url ?? "/",
        /*
          One lock-screen entry per event, one per kind for summaries. The tag
          used to be the kind for everything, so a second booking replaced the
          first on the phone and reception only ever saw the latest one.
        */
        tag: REPLACEABLE.has(n.kind) ? n.kind : n.id,
        lang: ARABIC.test(`${n.title} ${n.body}`) ? "ar" : "en",
        id: n.id,
        badge: await unreadCount(c, n.user_id),
      },
      { urgency: d.prompt ? "high" : "normal", ttl: d.ttl }
    );
  } catch (e) {
    console.error("[notify] push failed", (e as Error).message);
  }

  // Critical alerts fall back to the staff member's own WhatsApp
  if (sent === 0 && WHATSAPP_FALLBACK.has(n.kind) && n.phone_e164 && n.clinic_id) {
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

  await markPushed(c, [n.id]);
}

/**
 * Rows the phone will never be sent, marked so.
 *
 * Anything more than a day past its moment is not pushed (see the window
 * above), but it stayed unsent — and so stayed in the partial index the
 * delivery query scans every five seconds, growing forever after any day the
 * worker was down.
 */
async function sweepStale() {
  await withSystem((c) =>
    c.query(
      `update notifications set push_sent = true
        where not push_sent and coalesce(push_after, created_at) <= now() - interval '1 day'`
    )
  );
}

/** Recipients' languages, for the handful of rows a reminder or an alert writes. */
async function localesOf(c: PoolClient, userIds: string[]): Promise<Map<string, NLocale>> {
  if (!userIds.length) return new Map();
  const r = await c.query(`select id, locale from users where id = any($1::uuid[])`, [userIds]);
  return new Map(r.rows.map((x) => [x.id as string, asLocale(x.locale)]));
}

const capsOf = (m: StaffMember): CapabilityMap =>
  resolveCapabilities(m.permissions, { isOwner: m.isOwner, role: m.role as MemberRole });

/**
 * How late a reminder may still go out.
 *
 * It was ninety seconds, just wider than the one-minute tick. So a worker that
 * was restarting for longer than that — every deploy — silently skipped every
 * reminder whose moment fell in the gap. The dedupe key is what keeps a wider
 * window from sending twice, and the appointment having not started yet is what
 * keeps it from sending something useless.
 */
const REMINDER_CATCH_UP_MINUTES = 10;

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
      `select a.id, a.clinic_id, a.roles, a.minutes_before
         from clinic_staff_alerts a join clinics cl on cl.id = a.clinic_id
        where a.kind = 'appointment_reminder' and a.enabled
          and cl.subscription_status <> 'suspended' and cl.deleted_at is null`
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
           and a.starts_at - (coalesce($2::int, cm.reminder_minutes) * interval '1 minute')
                 > now() - ($3::int * interval '1 minute')
         limit 100`,
        [alert.clinic_id, lead, REMINDER_CATCH_UP_MINUTES]
      );
      if (!due.rowCount) continue;

      const roles = (alert.roles ?? []) as string[];
      // 'doctor' here means the appointment's own doctor, not every doctor in
      // the clinic — which is why it is handled separately from the rest.
      const alsoTell = roles.filter((r) => r !== "doctor");
      const extra = alsoTell.length
        ? (await staffMembersInRoles(c, alert.clinic_id as string, alsoTell)).filter(
            (m) => capsOf(m).calendar
          )
        : [];
      const locales = await localesOf(c, [
        ...due.rows.map((r) => r.user_id as string),
        ...extra.map((m) => m.userId),
      ]);

      for (const r of due.rows) {
        /*
          Keyed by the appointment *and its start time*. The window is wider
          than the one-minute tick so a late worker still sends, and the key is
          what stops consecutive ticks sending twice. The start time is in it
          so an appointment moved after its reminder went out is reminded again
          at its new time, rather than never.

          The alert id joins the key only for a row with its own lead time, so a
          doctor with two reminders configured gets both.
        */
        const at = `${r.id}@${Math.floor(new Date(r.starts_at).getTime() / 1000)}`;
        const dedupeKey = lead === null ? `doctor_reminder:${at}` : `doctor_reminder:${alert.id}:${at}`;
        const notice = (loc: NLocale, own: boolean) => {
          const L = NT[loc];
          const t = clock(r.starts_at, r.timezone, loc);
          const service = loc === "ar" ? r.service_name_ar || r.service_name : r.service_name;
          return {
            clinicId: r.clinic_id as string,
            kind: "doctor_reminder",
            title: own ? L.reminderOwn(t) : L.reminderOther(t),
            body: `${r.patient_name}${service ? ` — ${service}` : ""}`,
            url: `/c/${r.slug}/calendar`,
            dedupeKey,
          };
        };
        if (roles.includes("doctor")) {
          await notifyUser(c, r.user_id as string, notice(locales.get(r.user_id) ?? "ar", true));
        }
        for (const m of extra) {
          if (m.userId === r.user_id) continue;
          await notifyUser(c, m.userId, notice(locales.get(m.userId) ?? "ar", false));
        }
      }
    }
  });
}

/**
 * Claims a digest for one alert, for one local day.
 *
 * The scheduler ticks every minute and each digest fires inside a window after
 * its hour, so that a tick arriving late, or a worker restarting across the
 * hour, still sends. Without a claim that window means the notification is
 * inserted once per tick, which is what an owner saw: the same end-of-day
 * summary at 20:00, 20:01 and 20:02.
 *
 * The claim is a `jobs` row with a dedupe key, exactly as the e-sign digest and
 * every automation trigger already do. The unique index decides the winner, so
 * a second worker cannot send it either.
 *
 * Keyed by the alert rather than by the clinic and kind, because a clinic may
 * have two of the same kind at two different hours and those are two different
 * digests.
 */
async function claimDailyDigest(
  c: PoolClient,
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
 * How long after its hour a digest may still go out.
 *
 * Three minutes, until a deploy that happened to span eight o'clock — the
 * worker is down for longer than that while the new one boots — meant no
 * morning list for any clinic that day. The claim is what makes the width
 * safe: however many ticks land inside it, one of them sends.
 */
const DIGEST_CATCH_UP_MINUTES = 15;

/**
 * The scheduled digests, driven by the clinic's own alert rows.
 *
 * Nothing here decides *whether* a clinic gets a morning list or an end-of-day
 * summary any more, or at what hour, or who reads it — those are rows the
 * clinic can see and change on its automations page. This decides what each
 * one says.
 */
export async function dailyDigests() {
  await withSystem(async (c) => {
    const alerts = await c.query(
      `select a.id, a.clinic_id, a.kind, a.roles, a.at_hour, a.weekday, a.threshold,
              cl.slug, cl.timezone, cl.currency
       from clinic_staff_alerts a
       join clinics cl on cl.id = a.clinic_id
       where a.enabled and a.at_hour is not null
         and a.kind not in ('appointment_reminder', 'appointment_booked',
                            'appointment_cancelled', 'appointment_rescheduled')
         and cl.subscription_status <> 'suspended' and cl.deleted_at is null
       order by a.clinic_id, a.sort`
    );

    for (const alert of alerts.rows) {
      const now = DateTime.now().setZone(alert.timezone);
      if (now.hour !== (alert.at_hour ?? 8) || now.minute >= DIGEST_CATCH_UP_MINUTES) continue;
      if (alert.kind === "weekly_summary" && now.weekday !== (alert.weekday ?? 7)) continue;
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
  weekday?: number | null;
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
 *
 * Every recipient is also checked against what they may open: a summary whose
 * link lands on a screen somebody cannot reach is a notification about a door
 * they do not have the key to.
 */
export async function sendDigest(c: PoolClient, alert: DigestAlert, now: DateTime): Promise<void> {
  const today = now.toISODate()!;
  const todayStart = now.startOf("day");
  const roles = (alert.roles ?? []) as string[];
  if (!roles.length) return;
  const members = await staffMembersInRoles(c, alert.clinic_id, roles);
  const tz = alert.timezone;

  if (alert.kind === "day_schedule" || alert.kind === "tomorrow_schedule") {
    /*
      A doctor is sent their own list; anyone else on the alert is sent the
      clinic's. Reception asking "how busy are we today" and a doctor asking
      "what have I got" are the same question about different rows, and
      answering both with the doctor's list would make the alert useless to
      half the people receiving it.
    */
    const tomorrow = alert.kind === "tomorrow_schedule";
    const from = tomorrow ? todayStart.plus({ days: 1 }) : todayStart;
    const to = from.plus({ days: 1 });
    for (const m of members) {
      const own = m.role === "doctor";
      if (!own && !capsOf(m).calendar) continue;
      const appts = await c.query(
        `select count(*)::int as n, min(starts_at) as first from appointments
         where clinic_id = $1 and ($2::uuid is null or doctor_member_id = $2)
           and starts_at >= $3 and starts_at < $4 and status in ('scheduled', 'confirmed')`,
        [alert.clinic_id, own ? m.memberId : null, from.toUTC().toISO(), to.toUTC().toISO()]
      );
      const { n, first } = appts.rows[0];
      if (!n) continue;
      const loc = asLocale(m.locale);
      const L = NT[loc];
      const count = L.appts(n);
      await notifyUser(c, m.userId, {
        clinicId: alert.clinic_id,
        kind: tomorrow ? "tomorrow_schedule" : "daily_summary",
        title: tomorrow
          ? own
            ? L.tomorrowOwn(count)
            : L.tomorrowClinic(count)
          : own
            ? L.dayOwn(count)
            : L.dayClinic(count),
        body: L.firstAt(clock(first, tz, loc)),
        url: `/c/${alert.slug}/calendar`,
        dedupeKey: `${tomorrow ? "tomorrow_schedule" : "daily_summary"}:${alert.id}:${today}`,
      });
    }
  } else if (alert.kind === "unconfirmed_tomorrow") {
    /*
      The list reception works through before going home: tomorrow's
      appointments nobody has confirmed yet. Quiet when there are none — a
      nightly "0 to confirm" is how people learn to swipe the whole channel away.
    */
    const from = todayStart.plus({ days: 1 });
    const n = (
      await c.query(
        `select count(*)::int as n from appointments
          where clinic_id = $1 and starts_at >= $2 and starts_at < $3
            and status in ('scheduled', 'pending_approval')`,
        [alert.clinic_id, from.toUTC().toISO(), from.plus({ days: 1 }).toUTC().toISO()]
      )
    ).rows[0].n as number;
    if (!n) return;
    for (const m of members) {
      if (!capsOf(m).calendar) continue;
      const L = NT[asLocale(m.locale)];
      await notifyUser(c, m.userId, {
        clinicId: alert.clinic_id,
        kind: "unconfirmed_tomorrow",
        title: L.unconfirmedTitle(n),
        body: L.unconfirmedBody,
        url: `/c/${alert.slug}/calendar`,
        dedupeKey: `unconfirmed_tomorrow:${alert.id}:${today}`,
      });
    }
  } else if (alert.kind === "day_end" || alert.kind === "weekly_summary") {
    const weekly = alert.kind === "weekly_summary";
    const from = weekly ? todayStart.minus({ days: 7 }) : todayStart;
    const to = weekly ? todayStart : todayStart.plus({ days: 1 });
    const [stats] = (
      await c.query(
        `select
           (select count(*) from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'completed')::int as completed,
           (select count(*) from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'no_show')::int as no_show,
           (select count(*) from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'cancelled')::int as cancelled,
           (select count(*) from patients where clinic_id = $1 and created_at >= $2 and created_at < $3)::int as new_patients,
           (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $2 and paid_at < $3) as revenue`,
        [alert.clinic_id, from.toUTC().toISO(), to.toUTC().toISO()]
      )
    ).rows;
    const activity = weekly
      ? stats.completed + stats.no_show + stats.cancelled + stats.new_patients
      : stats.completed + stats.no_show;
    // A day with nothing in it is not news, and an empty summary every
    // evening is how a clinic learns to ignore the whole channel.
    if (!activity && Number(stats.revenue) <= 0) return;
    /*
      The takings go only to somebody who may see the takings.

      This alert picks its audience by job — doctor, receptionist, owner — and
      a job is not an access set. A doctor with the day-end alert switched on
      was being sent the clinic's revenue on their phone, which is the one
      number the owner had just finished taking off their screens. A
      notification is also the worst place to leak it: it survives on a lock
      screen, outside every gate the app has.

      Everybody still gets the summary; only the money is conditional. A
      recipient who may not see it and has nothing else to hear about is sent
      nothing at all rather than an empty line.
    */
    for (const m of members) {
      const maySeeMoney = capsOf(m)["invoices.analytics"] === true;
      if (!maySeeMoney && !activity) continue;
      const L = NT[asLocale(m.locale)];
      const money = maySeeMoney ? ` · ${Number(stats.revenue).toFixed(2)} ${alert.currency}` : "";
      await notifyUser(c, m.userId, {
        clinicId: alert.clinic_id,
        kind: alert.kind,
        title: weekly ? L.weekTitle : L.dayEndTitle,
        body:
          (weekly
            ? L.weekBody(stats.completed, stats.no_show, stats.cancelled, stats.new_patients)
            : L.dayEndBody(stats.completed, stats.no_show)) + money,
        url: `/c/${alert.slug}`,
        dedupeKey: `${alert.kind}:${alert.id}:${today}`,
      });
    }
  } else if (alert.kind === "unread_digest") {
    const unread = (
      await c.query(
        `select coalesce(sum(unread_count), 0)::int as n from conversations where clinic_id = $1`,
        [alert.clinic_id]
      )
    ).rows[0].n as number;
    if (!unread || unread < (alert.threshold ?? 0)) return;
    for (const m of members) {
      if (!capsOf(m).conversations) continue;
      const L = NT[asLocale(m.locale)];
      await notifyUser(c, m.userId, {
        clinicId: alert.clinic_id,
        kind: "unread_digest",
        title: L.unreadTitle(unread),
        body: L.unreadBody,
        url: `/c/${alert.slug}/conversations`,
        dedupeKey: `unread_digest:${alert.id}:${today}`,
      });
    }
  }
}

const ACTIVE = new Set(["pending_approval", "scheduled", "confirmed"]);

/**
 * The instant alerts: an appointment was booked, cancelled or moved.
 *
 * Called by the job runner for each appointment trigger, after the clinic's own
 * automations have run. Which alert — if any — a trigger means is decided here:
 *
 *   appointment_created                  → booked (unless it still awaits approval)
 *   status pending_approval → confirmed  → booked (it is on the list now)
 *   status → cancelled                   → cancelled
 *   appointment_rescheduled              → moved
 *
 * Nobody is told about a change they made themselves, and an appointment that
 * is already over is not news — reception entering yesterday's walk-ins should
 * not wake a doctor.
 *
 * Keyed by the job, so a retried job never sends twice.
 */
export async function appointmentAlerts(
  trigger: string,
  clinicId: string,
  payload: Record<string, unknown>,
  jobId: string
): Promise<void> {
  const status = String(payload.status ?? "");
  const prev = String(payload.previousStatus ?? "");
  const kind =
    trigger === "appointment_created"
      ? "appointment_booked"
      : trigger === "appointment_status_changed" &&
          prev === "pending_approval" &&
          (status === "scheduled" || status === "confirmed")
        ? "appointment_booked"
        : trigger === "appointment_status_changed" && status === "cancelled" && prev !== "cancelled"
          ? "appointment_cancelled"
          : trigger === "appointment_rescheduled"
            ? "appointment_rescheduled"
            : null;
  const appointmentId = typeof payload.appointmentId === "string" ? payload.appointmentId : null;
  if (!kind || !appointmentId) return;

  await withSystem(async (c) => {
    if (trigger === "appointment_rescheduled") {
      // The next move of this appointment is its own event, not a duplicate of this one.
      await c.query(`update jobs set dedupe_key = null where id = $1`, [jobId]);
    }

    const alerts = await c.query(
      `select roles from clinic_staff_alerts where clinic_id = $1 and kind = $2 and enabled`,
      [clinicId, kind]
    );
    const roles = new Set<string>(alerts.rows.flatMap((r) => (r.roles ?? []) as string[]));
    if (!roles.size) return;

    const a = (
      await c.query(
        `select a.id, a.starts_at, a.status, a.doctor_member_id,
                p.full_name as patient, s.name as service, s.name_ar as service_ar,
                cl.slug, cl.timezone, cl.subscription_status, cl.deleted_at,
                dm.user_id as doctor_user_id, dm.active as doctor_active, du.full_name as doctor_name
           from appointments a
           join patients p on p.id = a.patient_id
           join clinics cl on cl.id = a.clinic_id
           left join services s on s.id = a.service_id
           left join clinic_members dm on dm.id = a.doctor_member_id
           left join users du on du.id = dm.user_id
          where a.id = $1 and a.clinic_id = $2`,
        [appointmentId, clinicId]
      )
    ).rows[0];
    if (!a || a.deleted_at || a.subscription_status === "suspended") return;
    if (new Date(a.starts_at).getTime() < Date.now() - 60 * 60 * 1000) return;
    if (kind === "appointment_booked" && a.status === "pending_approval") return;
    if (kind !== "appointment_cancelled" && !ACTIVE.has(a.status)) return;

    const actor = typeof payload.actorUserId === "string" ? payload.actorUserId : null;
    const source = String(payload.source ?? "");

    // The previous place, for a move.
    let wasAt: string | null = null;
    let wasDoctor: { userId: string; active: boolean } | null = null;
    let doctorChanged = false;
    if (kind === "appointment_rescheduled") {
      wasAt = typeof payload.previousStartsAt === "string" ? payload.previousStartsAt : null;
      const prevDoctorId =
        typeof payload.previousDoctorMemberId === "string" ? payload.previousDoctorMemberId : null;
      doctorChanged = (prevDoctorId ?? null) !== (a.doctor_member_id ?? null);
      const timeChanged =
        !!wasAt && Math.abs(new Date(wasAt).getTime() - new Date(a.starts_at).getTime()) >= 60_000;
      // Moved and moved back inside the minute the event waits: nothing happened.
      if (!timeChanged && !doctorChanged) return;
      if (doctorChanged && prevDoctorId) {
        const r = (
          await c.query(`select user_id, active from clinic_members where id = $1 and clinic_id = $2`, [
            prevDoctorId,
            clinicId,
          ])
        ).rows[0];
        if (r) wasDoctor = { userId: r.user_id, active: r.active };
      }
    }

    type Recipient = { userId: string; as: "doctor" | "away" | "team" };
    const recipients = new Map<string, Recipient>();
    if (roles.has("doctor")) {
      if (a.doctor_user_id && a.doctor_active) {
        recipients.set(a.doctor_user_id, { userId: a.doctor_user_id, as: "doctor" });
      }
      if (wasDoctor?.active && wasDoctor.userId !== a.doctor_user_id) {
        recipients.set(wasDoctor.userId, { userId: wasDoctor.userId, as: "away" });
      }
    }
    const team = [...roles].filter((r) => r !== "doctor");
    if (team.length) {
      for (const m of await staffMembersInRoles(c, clinicId, team)) {
        if (recipients.has(m.userId) || !capsOf(m).calendar) continue;
        /*
          A booking from the public link or the AI receptionist has already
          told the front desk, with the patient's answers in it. Telling the
          same people again that an appointment exists is the second buzz for
          one event.
        */
        if (
          kind === "appointment_booked" &&
          (source === "booking_link" || source === "ai_agent") &&
          (m.isOwner || m.role === "receptionist")
        ) {
          continue;
        }
        recipients.set(m.userId, { userId: m.userId, as: "team" });
      }
    }
    if (actor) recipients.delete(actor);
    if (!recipients.size) return;

    const locales = await localesOf(c, [...recipients.keys()]);
    const newDoctorName = a.doctor_name as string | null;
    for (const r of recipients.values()) {
      const loc = locales.get(r.userId) ?? "ar";
      const L = NT[loc];
      const service = loc === "ar" ? a.service_ar || a.service : a.service;
      const at = when(a.starts_at, a.timezone, loc);
      const withDoctor = newDoctorName ? ` · ${newDoctorName}` : "";
      let title: string;
      let body: string;
      if (kind === "appointment_booked") {
        title = r.as === "doctor" ? L.bookedOwn(a.patient) : L.bookedOther(a.patient);
        body = [service, at].filter(Boolean).join(" · ") + (r.as === "team" ? withDoctor : "");
      } else if (kind === "appointment_cancelled") {
        title = L.cancelledTitle(a.patient);
        body = at + (r.as === "team" ? withDoctor : "");
      } else if (r.as === "away") {
        title = L.awayTitle(a.patient);
        body = L.awayBody(at, newDoctorName ?? L.unassigned);
      } else if (r.as === "doctor" && doctorChanged) {
        title = L.bookedOwn(a.patient);
        body = [service, at].filter(Boolean).join(" · ");
      } else {
        title = L.movedTitle(a.patient);
        body = (wasAt ? L.movedBody(at, when(wasAt, a.timezone, loc)) : at) + (r.as === "team" ? withDoctor : "");
      }
      await notifyUser(c, r.userId, {
        clinicId,
        kind,
        title,
        body,
        url: `/c/${a.slug}/calendar`,
        dedupeKey: `${kind}:${jobId}`,
      });
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
    for (const fn of [doctorReminders, dailyDigests, sweepStale]) {
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
