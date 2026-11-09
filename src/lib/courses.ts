import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { FACE_TREATMENT_BY_KEY } from "./charts/face/catalog";
import { treatmentName } from "./charts/dental/treatment-events";
import { isToothSite } from "./charts/dental/state";

/**
 * The treatment coordinator's one question (a test, behind the opt-in
 * `coordinator` feature, migration 0102): which patients are part-way through
 * a treatment with nothing booked, and when is their next session due?
 *
 * Read from what the clinic already records, so nobody sets anything up for
 * it. Four places say a treatment has more to come, and they are merged into
 * one next session per patient — never two messages for one patient:
 *
 * 1. The finish sheet's "next visit in N days" (0088). The doctor said so,
 *    for this patient, so it beats every rule below.
 * 2. A face package with sessions left and not expired: last session + the
 *    plan's spacing (four weeks unless the plan says), two days after the
 *    sale if none is used yet.
 * 3. A service given as a course (`services.course_sessions`): sessions
 *    attended of that service, the next one the service's spacing after the
 *    last.
 * 4. A dental plan with work still planned. Only ever an invitation: whether
 *    the patient took the plan, how long the next visit is and who does it
 *    are what a receptionist asks, not what a system guesses.
 *
 * Attended is completed, or in the past and neither cancelled nor missed — a
 * clinic that never presses Finish still has its sessions counted.
 *
 * And the ones it leaves alone: a patient with anything booked ahead (that is
 * the answer), one reception stopped following since the treatment began,
 * and a stalled one — the last automatic booking was missed or cancelled, or
 * the session is a month overdue. A stalled patient is reception's call, on
 * the Treatments list; the system does not keep booking someone who keeps
 * not coming.
 */

export type TreatmentSource = "next_visit" | "package" | "course" | "plan";
export type TreatmentState = "due" | "upcoming" | "booked" | "auto_booked" | "stalled" | "stopped";

export type OpenTreatment = {
  patientId: string;
  patientName: string;
  phone: string | null;
  source: TreatmentSource;
  /** Book it (the next visit is clear) or invite them (it is not: a dental plan). */
  action: "book" | "invite";
  name: string;
  nameAr: string;
  /** Teeth, for a dental plan. */
  tooth: string;
  /** Sessions done so far, and how many in all when that is known. */
  done: number;
  total: number | null;
  /** The next session's day, in the clinic's calendar. */
  dueOn: string;
  /** The last session, which a booking copies its time of day from. */
  lastAppointmentId: string | null;
  serviceId: string | null;
  doctorId: string | null;
  state: TreatmentState;
  /** The visit already booked, when one is. */
  bookedAppointmentId: string | null;
  bookedAt: string | null;
  /** Other treatments this patient has open, folded into this one. */
  others: number;
  /** When the last session was, for a booking at the time they usually come. */
  lastAt: string | null;
};

/** Never booked: more than this many days overdue is reception's, not the system's. */
export const STALL_DAYS = 30;
/** A booking is made for a session at most this many days late — an outage, not last month. */
export const LATE_GRACE_DAYS = 3;

type Item = Omit<OpenTreatment, "patientName" | "phone" | "state" | "bookedAppointmentId" | "bookedAt" | "others" | "lastAt"> & {
  /** When this treatment began: a stop pressed before it does not apply to it. */
  startedAt: Date;
  /** The last session, for the "missed the automatic booking" check. */
  lastAt: Date | null;
};

const iso = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz);

export async function openTreatments(
  c: PoolClient,
  clinicId: string,
  opts: { patientId?: string; aheadDays?: number } = {}
): Promise<OpenTreatment[]> {
  const clinic = (await c.query(`select timezone from clinics where id = $1`, [clinicId])).rows[0];
  if (!clinic) return [];
  const tz = String(clinic.timezone);
  const today = DateTime.now().setZone(tz).startOf("day");
  const ahead = opts.aheadDays ?? 7;
  const patient = opts.patientId ?? null;
  const items: Item[] = [];

  /* 1. The finish sheet's next visit, newest per patient, not yet come to. */
  const nv = await c.query(
    `with latest as (
       select distinct on (a.patient_id) a.id, a.patient_id, a.starts_at, coalesce(a.finished_at, a.starts_at) as at,
              a.next_visit_days, coalesce(a.next_visit_member_id, a.doctor_member_id) as doctor_id, a.service_id
         from appointments a
        where a.clinic_id = $1 and a.status = 'completed' and a.next_visit_days is not null
          and ($2::uuid is null or a.patient_id = $2)
        order by a.patient_id, coalesce(a.finished_at, a.starts_at) desc
     )
     select l.*, s.name, s.name_ar from latest l
       left join services s on s.id = l.service_id
      where not exists (
        select 1 from appointments b
         where b.clinic_id = $1 and b.patient_id = l.patient_id and b.starts_at > l.starts_at and b.starts_at < now()
           and b.status not in ('cancelled', 'no_show', 'pending_approval'))`,
    [clinicId, patient]
  );
  for (const r of nv.rows) {
    items.push({
      patientId: r.patient_id,
      source: "next_visit",
      action: "book",
      name: r.name ?? "",
      nameAr: r.name_ar ?? "",
      tooth: "",
      done: 0,
      total: null,
      dueOn: iso(r.at, tz).plus({ days: Number(r.next_visit_days) }).toISODate()!,
      lastAppointmentId: r.id,
      serviceId: r.service_id ?? null,
      doctorId: r.doctor_id ?? null,
      startedAt: r.at,
      lastAt: r.starts_at,
    });
  }

  /* 2. Face packages with sessions left. */
  const pk = await c.query(
    `select i.id, pp.patient_id, pp.created_at, pp.name as package_name, pp.name_ar as package_name_ar,
            i.treatment_key, i.sessions, coalesce(pl.interval_days, 28) as interval_days,
            (select count(*)::int from chart_marks s where s.package_item_id = i.id and s.voided_at is null) as used,
            last.at as last_at, last.label, last.label_ar,
            coalesce(la.id, sa.id) as appt_id, coalesce(la.doctor_member_id, sa.doctor_member_id) as doctor_id,
            coalesce(la.service_id, ks.id, sa.service_id) as service_id, ks.name as service_name, ks.name_ar as service_name_ar
       from patient_package_items i
       join patient_packages pp on pp.id = i.patient_package_id
       join chart_marks sale on sale.id = pp.sale_mark_id and sale.voided_at is null
       left join package_plans pl on pl.id = pp.plan_id
       left join lateral (
         select coalesce(s.done_at, s.created_at) as at, s.appointment_id, s.label, s.label_ar from chart_marks s
          where s.package_item_id = i.id and s.voided_at is null
          order by coalesce(s.done_at, s.created_at) desc limit 1
       ) last on true
       left join appointments la on la.id = last.appointment_id
       left join appointments sa on sa.id = sale.appointment_id
       left join lateral (
         select id, name, name_ar from services where clinic_id = $1 and chart_key = i.treatment_key and active order by created_at limit 1
       ) ks on true
      where pp.clinic_id = $1 and ($2::uuid is null or pp.patient_id = $2)
        and (pp.expires_on is null or pp.expires_on >= (now() at time zone $3)::date)
        and (select count(*) from chart_marks s where s.package_item_id = i.id and s.voided_at is null) < i.sessions`,
    [clinicId, patient, tz]
  );
  for (const r of pk.rows) {
    const t = FACE_TREATMENT_BY_KEY.get(r.treatment_key);
    const due = r.last_at ? iso(r.last_at, tz).plus({ days: Number(r.interval_days) }) : iso(r.created_at, tz).plus({ days: 2 });
    items.push({
      patientId: r.patient_id,
      source: "package",
      action: "book",
      name: r.label ?? r.service_name ?? t?.en ?? r.package_name ?? "",
      nameAr: r.label_ar ?? r.service_name_ar ?? t?.ar ?? r.package_name_ar ?? "",
      tooth: "",
      done: Number(r.used),
      total: Number(r.sessions),
      dueOn: due.toISODate()!,
      lastAppointmentId: r.appt_id ?? null,
      serviceId: r.service_id ?? null,
      doctorId: r.doctor_id ?? null,
      startedAt: r.created_at,
      lastAt: r.last_at ?? r.created_at,
    });
  }

  /* 3. Services given as a course: the sessions of the current run of them. */
  const cs = await c.query(
    `select a.id, a.patient_id, a.service_id, a.starts_at, a.doctor_member_id as doctor_id,
            s.name, s.name_ar, s.course_sessions, coalesce(s.course_interval_days, 14) as interval_days
       from appointments a
       join services s on s.id = a.service_id and s.course_sessions is not null and s.active
      where a.clinic_id = $1 and ($2::uuid is null or a.patient_id = $2)
        and a.starts_at > now() - interval '400 days' and a.starts_at < now()
        and a.status not in ('cancelled', 'no_show', 'pending_approval')
      order by a.patient_id, a.service_id, a.starts_at`,
    [clinicId, patient]
  );
  type Run = { rows: typeof cs.rows };
  const runs = new Map<string, Run>();
  for (const r of cs.rows) {
    const key = `${r.patient_id}:${r.service_id}`;
    const run = runs.get(key) ?? { rows: [] };
    const prev = run.rows[run.rows.length - 1];
    const gap = prev ? (new Date(r.starts_at).getTime() - new Date(prev.starts_at).getTime()) / 86_400_000 : 0;
    /*
      A long break and the next session starts a new course. Sessions right
      after a finished one are top-ups of it, not session 2 of another.
    */
    if (prev && gap > Number(r.interval_days) * 3 + STALL_DAYS) run.rows = [];
    run.rows.push(r);
    runs.set(key, run);
  }
  for (const { rows } of runs.values()) {
    const last = rows[rows.length - 1];
    const total = Number(last.course_sessions);
    if (rows.length >= total) continue;
    items.push({
      patientId: last.patient_id,
      source: "course",
      action: "book",
      name: last.name ?? "",
      nameAr: last.name_ar ?? "",
      tooth: "",
      done: rows.length,
      total,
      dueOn: iso(last.starts_at, tz).plus({ days: Number(last.interval_days) }).toISODate()!,
      lastAppointmentId: last.id,
      serviceId: last.service_id,
      doctorId: last.doctor_id ?? null,
      startedAt: rows[0].starts_at,
      lastAt: last.starts_at,
    });
  }

  /* 4. Dental work still planned, charted in the last six months: an invitation, never a booking. */
  const dp = await c.query(
    `select m.id, m.patient_id, m.label, m.label_ar, m.site, m.created_at, last.at as last_at, last.appointment_id
       from chart_marks m
       left join lateral (
         select s.done_at as at, s.appointment_id from chart_mark_steps s
          where s.mark_id = m.id and s.voided_at is null and s.step <> 'emergency'
          order by s.done_at desc limit 1
       ) last on true
      where m.clinic_id = $1 and m.chart = 'dental' and m.kind = 'procedure' and m.status = 'planned'
        and m.voided_at is null and m.created_at > now() - interval '180 days'
        and ($2::uuid is null or m.patient_id = $2)
      order by m.patient_id, m.created_at`,
    [clinicId, patient]
  );
  const plans = new Map<string, { marks: typeof dp.rows; dues: DateTime[] }>();
  for (const r of dp.rows) {
    const due = r.last_at ? iso(r.last_at, tz).plus({ days: 7 }) : iso(r.created_at, tz).plus({ days: 2 });
    const p = plans.get(r.patient_id) ?? { marks: [], dues: [] };
    p.marks.push(r);
    p.dues.push(due);
    plans.set(r.patient_id, p);
  }
  for (const [patientId, p] of plans) {
    // Marks long overdue are the plan's past, not its next visit — unless nothing newer is there.
    const fresh = p.marks.map((m, i) => ({ m, due: p.dues[i] })).filter((x) => x.due >= today.minus({ days: STALL_DAYS }));
    const use = fresh.length ? fresh : p.marks.map((m, i) => ({ m, due: p.dues[i] }));
    const names = (l: "ar" | "en") => [...new Set(use.map((x) => treatmentName(x.m, l)))].join(l === "en" ? ", " : "، ");
    const teeth = [...new Set(use.map((x) => x.m.site).filter((s) => isToothSite(s)))];
    const started = use.filter((x) => x.m.last_at).sort((a, b) => +new Date(b.m.last_at) - +new Date(a.m.last_at))[0];
    const first = use.reduce((a, b) => (a.due <= b.due ? a : b));
    items.push({
      patientId,
      source: "plan",
      action: "invite",
      name: names("en"),
      nameAr: names("ar"),
      tooth: teeth.join(", "),
      done: 0,
      total: null,
      dueOn: first.due.toISODate()!,
      lastAppointmentId: started?.m.appointment_id ?? null,
      serviceId: null,
      doctorId: null,
      startedAt: use.reduce((a, b) => (new Date(a.m.created_at) <= new Date(b.m.created_at) ? a : b)).m.created_at,
      lastAt: started ? started.m.last_at : null,
    });
  }

  if (!items.length) return [];

  /* The patients: still on file, what they have booked, when reception stopped following them. */
  const ids = [...new Set(items.map((i) => i.patientId))];
  const pr = await c.query(
    `select p.id, p.full_name, p.phone_e164,
            up.id as up_id, up.starts_at as up_at, up.source as up_source,
            (select max(t.created_at) from treatment_follow_stops t where t.clinic_id = $1 and t.patient_id = p.id) as stopped_at,
            (select max(b.starts_at) from appointments b
              where b.clinic_id = $1 and b.patient_id = p.id and b.starts_at < now()
                and b.status not in ('cancelled', 'no_show', 'pending_approval')) as attended_at,
            (select max(b.starts_at) from appointments b
              where b.clinic_id = $1 and b.patient_id = p.id and b.source = 'automation'
                and b.status in ('cancelled', 'no_show')) as missed_at
       from patients p
       left join lateral (
         select b.id, b.starts_at, b.source from appointments b
          where b.clinic_id = $1 and b.patient_id = p.id and b.starts_at > now()
            and b.status in ('pending_approval', 'scheduled', 'confirmed')
          order by b.starts_at limit 1
       ) up on true
      where p.clinic_id = $1 and p.id = any($2::uuid[]) and p.merged_into is null and p.status <> 'archived'`,
    [clinicId, ids]
  );
  const people = new Map(pr.rows.map((r) => [r.id as string, r]));

  const order: Record<TreatmentSource, number> = { next_visit: 0, package: 1, course: 1, plan: 2 };
  const out: OpenTreatment[] = [];
  for (const patientId of ids) {
    const p = people.get(patientId);
    if (!p) continue;
    const mine = items.filter((i) => i.patientId === patientId);
    const stopped = (i: Item) => p.stopped_at && new Date(p.stopped_at) >= new Date(i.startedAt);
    const live = mine.filter((i) => !stopped(i));
    const pool = live.length ? live : mine;
    let pick = [...pool].sort((a, b) => order[a.source] - order[b.source] || a.dueOn.localeCompare(b.dueOn))[0];
    // The doctor's "come back in…" after a course session is that course's next session: say which.
    const sameCourse =
      pick.source === "next_visit" ? pool.find((i) => i.source === "course" && !!i.serviceId && i.serviceId === pick.serviceId) : undefined;
    if (sameCourse) pick = { ...pick, done: sameCourse.done, total: sameCourse.total };

    let state: TreatmentState;
    if (!live.length) state = "stopped";
    else if (p.up_id) state = p.up_source === "automation" ? "auto_booked" : "booked";
    else if (
      p.missed_at &&
      (!pick.lastAt || new Date(p.missed_at) > new Date(pick.lastAt)) &&
      (!p.attended_at || new Date(p.attended_at) < new Date(p.missed_at))
    )
      state = "stalled";
    else if (pick.dueOn < today.minus({ days: STALL_DAYS }).toISODate()!) state = "stalled";
    else if (pick.dueOn <= today.plus({ days: ahead }).toISODate()!) state = "due";
    else state = "upcoming";

    const { startedAt: _s, lastAt, ...rest } = pick;
    void _s;
    out.push({
      ...rest,
      lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      patientName: p.full_name,
      phone: p.phone_e164 ?? null,
      state,
      bookedAppointmentId: p.up_id ?? null,
      bookedAt: p.up_at ? new Date(p.up_at).toISOString() : null,
      others: pool.length - 1 - (sameCourse ? 1 : 0),
    });
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/** Whether the coordinator may act on this one today: due, not too late, and booked or invited by its action. */
export function actionableToday(t: OpenTreatment, tz: string, daysAhead: number): boolean {
  if (t.state !== "due") return false;
  const today = DateTime.now().setZone(tz).startOf("day");
  return t.dueOn >= today.minus({ days: LATE_GRACE_DAYS }).toISODate()! && t.dueOn <= today.plus({ days: daysAhead }).toISODate()!;
}

/**
 * "الجلسة 3 من 6", "Session 3 of 6" — the session this booking is for. With no
 * count to go by, the next session of the treatment, which is always true.
 */
export function sessionLabel(t: { done: number; total: number | null; action: "book" | "invite" }, locale: string): string {
  const en = locale === "en";
  if (t.total && t.done < t.total) return en ? `Session ${t.done + 1} of ${t.total}` : `الجلسة ${t.done + 1} من ${t.total}`;
  if (t.action === "invite") return en ? "the next visit of your treatment plan" : "الزيارة التالية من خطة علاجك";
  return en ? "your next session" : "جلستك القادمة";
}

/**
 * The visit an enquiry is booked into: the clinic's consultation — the first
 * active service called كشفية, استشارة, معاينة or consultation — else its
 * first bookable one. Never a chart's price-list entry. Shown on the
 * Treatments list, so reception can see what "book the consultation" books.
 */
export async function consultationService(
  c: PoolClient,
  clinicId: string
): Promise<{ id: string; name: string; nameAr: string | null } | null> {
  const r = await c.query(
    `select id, name, name_ar from services
      where clinic_id = $1 and active and bookable_online and chart_key is null
      order by (coalesce(name, '') || ' ' || coalesce(name_ar, '')) ~* '(كشف|استشار|معاين|consult)' desc, sort, created_at
      limit 1`,
    [clinicId]
  );
  const x = r.rows[0];
  return x ? { id: x.id, name: x.name, nameAr: x.name_ar ?? null } : null;
}

/** The coordinator's own flows: installed, switched and counted together. */
export const COORDINATOR_RECIPES = ["coordinator_next_session", "coordinator_plan_invite", "coordinator_enquiry"] as const;
/** The flows that would handle the same patient a second time while the coordinator is on. */
export const COORDINATOR_REPLACES = ["next_visit_due_book", "dental_next_visit_unbooked"] as const;

export type CoordinatorStats = {
  booked: number;
  confirmed: number;
  attended: number;
  noShow: number;
  cancelled: number;
  invited: number;
  enquiries: number;
  enquiriesBooked: number;
};

/**
 * The last thirty days of it, which is what decides whether it leaves the
 * test: of what it booked, how much was kept, and how much was undone.
 */
export async function coordinatorStats(c: PoolClient, clinicId: string): Promise<CoordinatorStats> {
  const r = await c.query(
    `with runs as (
       select r.id, r.appointment_id, (r.context ? 'booked_from') as booked, a.recipe_key
         from automation_runs r join automations a on a.id = r.automation_id
        where r.clinic_id = $1 and a.recipe_key = any($2::text[]) and r.started_at > now() - interval '30 days'
          and coalesce(r.context->>'test', 'false') <> 'true'
     )
     select
       count(*) filter (where r.booked)::int as booked,
       count(*) filter (where r.booked and b.status in ('confirmed', 'completed'))::int as confirmed,
       count(*) filter (where r.booked and b.starts_at < now() and b.status not in ('cancelled', 'no_show', 'pending_approval'))::int as attended,
       count(*) filter (where r.booked and b.status = 'no_show')::int as no_show,
       count(*) filter (where r.booked and b.status = 'cancelled')::int as cancelled,
       count(*) filter (where r.recipe_key = 'coordinator_plan_invite')::int as invited,
       count(*) filter (where r.recipe_key = 'coordinator_enquiry')::int as enquiries,
       count(*) filter (where r.booked and r.recipe_key = 'coordinator_enquiry')::int as enquiries_booked
       from runs r left join appointments b on b.id = r.appointment_id`,
    [clinicId, [...COORDINATOR_RECIPES]]
  );
  const x = r.rows[0] ?? {};
  return {
    booked: x.booked ?? 0,
    confirmed: x.confirmed ?? 0,
    attended: x.attended ?? 0,
    noShow: x.no_show ?? 0,
    cancelled: x.cancelled ?? 0,
    invited: x.invited ?? 0,
    enquiries: x.enquiries ?? 0,
    enquiriesBooked: x.enquiries_booked ?? 0,
  };
}
