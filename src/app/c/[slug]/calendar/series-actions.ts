"use server";

/*
  Repeating appointments (migration 0126): "every 4 weeks, 6 times" booked in
  one go from the booking panel.

  Two steps, because a series is a list of dates the desk should see before
  any of them is written: some will land on a day the doctor is busy, away or
  not working. `planSeriesAction` says which, and for a busy one the nearest
  free time that day; the desk unticks what it does not want and
  `createSeriesAction` books the rest — each date checked again under the
  schedule lock, so one taken in the meantime is skipped and reported, never
  double-booked.

  The clinic hears about the series once: `appointment_created` fires for the
  first visit only, so the confirmation, the doctor's alert and the waitlist
  each act once — and the patient is sent the list of dates in one message.
  The reminder before each visit still comes, because that is time-based.
*/

import { DateTime } from "luxon";
import { revalidatePath } from "next/cache";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { emitTrigger } from "@/lib/triggers";
import { findOrCreatePatient } from "@/lib/patients";
import { scheduleCheck } from "@/lib/schedule-check";
import { applyAppointmentStatus } from "@/lib/appointments";
import { cleanServiceIds, setExtraServices } from "@/lib/appointment-services";
import { computeSlots, isOffOn } from "@/lib/slots";
import { effectiveHours, isWithinHours, type WeeklyHours } from "@/lib/hours";
import { HOLDS_SLOT } from "@/lib/rooms";
import { MAX_SERIES, MIN_SERIES, parseRepeat, seriesStarts, type Repeat } from "@/lib/series";
import { tellPatientSeries } from "@/lib/series-message";
import { isUuid } from "@/lib/uuid";

export type SeriesDate = {
  /** UTC ISO: the time asked for, at the series' own clinic-local hour. */
  startsAt: string;
  /** busy — the doctor has somebody then; off — a day off; closed — outside the hours, or a day the clinic is shut. */
  status: "ok" | "busy" | "off" | "closed";
  conflictWith?: string;
  /** For a busy one: the nearest free time that day with the same doctor, if any. */
  alt?: string | null;
};

type PlanInput = {
  doctorMemberId: string | null;
  serviceIds: string[];
  startsAt: string;
  durationMin: number;
  repeat: Repeat;
  count: number;
};

function cleanPlan(input: PlanInput): (PlanInput & { first: DateTime }) | null {
  const repeat = parseRepeat(input.repeat);
  const count = Math.floor(Number(input.count));
  const duration = Math.floor(Number(input.durationMin));
  if (!repeat || !Number.isFinite(count) || count < MIN_SERIES || count > MAX_SERIES) return null;
  if (!Number.isFinite(duration) || duration < 5 || duration > 480) return null;
  if (input.doctorMemberId !== null && !isUuid(input.doctorMemberId)) return null;
  const first = DateTime.fromISO(String(input.startsAt), { zone: "utc" });
  if (!first.isValid) return null;
  return { ...input, repeat, count, durationMin: duration, serviceIds: cleanServiceIds(input.serviceIds), first };
}

/** The dates a series would take, each with what is in its way. Writes nothing. */
export async function planSeriesAction(slug: string, input: PlanInput): Promise<{ dates?: SeriesDate[]; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  const plan = cleanPlan(input);
  if (!plan) return { error: "invalid" };
  const tz = access.clinic.timezone;
  const starts = seriesStarts(plan.first.setZone(tz), plan.repeat, plan.count);
  const span = { from: starts[0].toUTC().toISO()!, to: starts[starts.length - 1].plus({ minutes: plan.durationMin }).toUTC().toISO()! };

  return inClinic(access, async (c) => {
    const clinic = (await c.query(`select working_hours, blocked_dates from clinics where id = $1`, [access.clinicId])).rows[0];
    const clinicHours = (clinic?.working_hours ?? {}) as WeeklyHours;
    const blocked = new Set<string>((clinic?.blocked_dates ?? []) as string[]);
    let doctorHours: WeeklyHours | null = null;
    let busy: { starts_at: Date; ends_at: Date; patient: string }[] = [];
    let off: [string, string][] = [];
    if (plan.doctorMemberId) {
      const doc = (
        await c.query(`select working_hours from clinic_members where id = $1 and clinic_id = $2`, [plan.doctorMemberId, access.clinicId])
      ).rows[0];
      if (!doc) return { error: "invalid" };
      doctorHours = (doc.working_hours ?? null) as WeeklyHours | null;
      busy = (
        await c.query(
          `select a.starts_at, a.ends_at, p.full_name as patient from appointments a
             join patients p on p.id = a.patient_id
            where a.clinic_id = $1 and a.doctor_member_id = $2 and a.status in ${HOLDS_SLOT}
              and a.starts_at < $4 and a.ends_at > $3`,
          [access.clinicId, plan.doctorMemberId, span.from, span.to]
        )
      ).rows;
      off = (
        await c.query(
          `select starts_on::text as starts_on, ends_on::text as ends_on from doctor_time_off
            where clinic_id = $1 and member_id = $2 and ends_on >= $3::date and starts_on <= $4::date`,
          [access.clinicId, plan.doctorMemberId, starts[0].toISODate(), starts[starts.length - 1].toISODate()]
        )
      ).rows.map((r) => [r.starts_on as string, r.ends_on as string] as [string, string]);
    }
    const hours = effectiveHours(clinicHours, doctorHours);

    const dates: SeriesDate[] = [];
    for (const s of starts) {
      const e = s.plus({ minutes: plan.durationMin });
      const day = s.toISODate()!;
      const clash = busy.find((b) => b.starts_at.getTime() < e.toMillis() && b.ends_at.getTime() > s.toMillis());
      if (clash) dates.push({ startsAt: s.toUTC().toISO()!, status: "busy", conflictWith: clash.patient });
      else if (plan.doctorMemberId && isOffOn(off, day)) dates.push({ startsAt: s.toUTC().toISO()!, status: "off" });
      else if (blocked.has(day) || !isWithinHours(hours, s, e)) dates.push({ startsAt: s.toUTC().toISO()!, status: "closed" });
      else dates.push({ startsAt: s.toUTC().toISO()!, status: "ok" });
    }

    /*
      A busy date offers the free time nearest the one asked for, that same
      day, with the same doctor — the slot engine's answer, so it honours
      hours, rooms and buffers. Only where there is a service to size it by.
    */
    if (plan.doctorMemberId && plan.serviceIds.length) {
      for (const d of dates) {
        if (d.status !== "busy") continue;
        const want = DateTime.fromISO(d.startsAt).setZone(tz);
        const slots = await computeSlots(c, {
          clinicId: access.clinicId,
          tz,
          clinicHours,
          blockedDates: [...blocked],
          serviceId: plan.serviceIds[0],
          extraServiceIds: plan.serviceIds.slice(1),
          doctorMemberId: plan.doctorMemberId,
          minNoticeMin: 0,
          granularityMin: 15,
          linkDoctorIds: [],
          dateISO: want.toISODate()!,
        });
        let best: string | null = null;
        let gap = Infinity;
        for (const sl of slots) {
          const g = Math.abs(Date.parse(sl.startISO) - want.toMillis());
          if (g < gap) {
            gap = g;
            best = sl.startISO;
          }
        }
        d.alt = best;
      }
    }
    return { dates };
  });
}

export type SeriesInput = {
  patientId?: string;
  newPatient?: { fullName: string; phone: string };
  doctorMemberId: string | null;
  serviceIds: string[];
  durationMin: number;
  notes: string;
  markIds?: string[];
  roomId?: string | null;
  repeat: Repeat;
  /** UTC ISO starts the desk kept ticked — a busy one already swapped for its free time. */
  dates: string[];
  /** Send the patient the list of dates on WhatsApp. */
  sendDates: boolean;
};

export type SeriesResult = {
  error?: string;
  seriesId?: string;
  booked?: string[];
  /** Dates taken between the preview and the press, left out. */
  skipped?: { startsAt: string; error: string; conflictWith?: string }[];
  /** The patient's list went out (or was queued) on WhatsApp. */
  told?: boolean;
};

/** Books every date of a series, each checked again under the schedule lock. */
export async function createSeriesAction(slug: string, input: SeriesInput): Promise<SeriesResult> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  const repeat = parseRepeat(input.repeat);
  const duration = Math.floor(Number(input.durationMin));
  if (!repeat || !Number.isFinite(duration) || duration < 5 || duration > 480) return { error: "invalid" };
  if (input.doctorMemberId !== null && !isUuid(input.doctorMemberId)) return { error: "invalid" };
  if (!Array.isArray(input.dates)) return { error: "invalid" };
  const starts = [...new Set(input.dates.map((d) => DateTime.fromISO(String(d), { zone: "utc" })).filter((d) => d.isValid).map((d) => d.toISO()!))].sort();
  if (starts.length < MIN_SERIES || starts.length > MAX_SERIES || starts.length !== input.dates.length) return { error: "invalid" };
  const services = cleanServiceIds(input.serviceIds);
  const serviceId = services[0] ?? null;

  return inClinic(access, async (c) => {
    let patientId = input.patientId && isUuid(input.patientId) ? input.patientId : undefined;
    if (!patientId && input.newPatient) {
      if (!input.newPatient.fullName.trim()) return { error: "patient_required" };
      const r = await findOrCreatePatient(c, access.clinicId, {
        phone: input.newPatient.phone,
        fullName: input.newPatient.fullName,
        source: "staff",
        createdBy: access.session.user.id,
      });
      patientId = r.id;
    }
    if (!patientId) return { error: "patient_required" };
    const known = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [patientId, access.clinicId]);
    if (!known.rowCount) return { error: "patient_required" };

    const series = (
      await c.query(
        `insert into appointment_series (clinic_id, patient_id, every, unit, planned, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [access.clinicId, patientId, repeat.every, repeat.unit, starts.length, access.session.user.id]
      )
    ).rows[0].id as string;

    const booked: { id: string; startsAt: string }[] = [];
    const skipped: NonNullable<SeriesResult["skipped"]> = [];
    const marks = (input.markIds ?? []).filter((x) => isUuid(x)).slice(0, 20);
    for (const startsAt of starts) {
      const endsAt = DateTime.fromISO(startsAt).plus({ minutes: duration }).toUTC().toISO()!;
      const check = await scheduleCheck(c, access.clinicId, {
        doctorMemberId: input.doctorMemberId,
        serviceId,
        startsAt,
        endsAt,
        roomId: input.roomId ?? null,
      });
      if (check.error) {
        skipped.push({ startsAt, error: check.error, ...(check.conflictWith ? { conflictWith: check.conflictWith } : {}) });
        continue;
      }
      const id = (
        await c.query(
          `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, notes, source, created_by, room_id, series_id)
           values ($1, $2, $3, $4, $5, $6, $7, 'staff', $8, $9, $10) returning id`,
          [access.clinicId, patientId, input.doctorMemberId, serviceId, startsAt, endsAt, String(input.notes ?? "").slice(0, 2000), access.session.user.id, check.roomId, series]
        )
      ).rows[0].id as string;
      if (services.length > 1) await setExtraServices(c, access.clinicId, id, serviceId, services.slice(1));
      // The plan's treatments are what the first visit is for; the rest are its repeats.
      if (!booked.length && marks.length) {
        await c.query(
          `insert into appointment_items (clinic_id, appointment_id, mark_id, patient_id, added_by)
           select $1, $2, m.id, m.patient_id, $4
             from chart_marks m
            where m.id = any($3::uuid[]) and m.clinic_id = $1 and m.patient_id = $5 and m.voided_at is null
           on conflict do nothing`,
          [access.clinicId, id, marks, access.session.user.id, patientId]
        );
      }
      booked.push({ id, startsAt });
    }

    if (!booked.length) {
      await c.query(`delete from appointment_series where id = $1`, [series]);
      return { error: skipped[0]?.error ?? "conflict", skipped };
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.series_create",
      entity: "patient",
      entityId: patientId,
      detail: { seriesId: series, every: repeat.every, unit: repeat.unit, ids: booked.map((b) => b.id), skipped },
    });
    await emitTrigger(c, access.clinicId, "appointment_created", {
      appointmentId: booked[0].id,
      patientId,
      source: "staff",
      actorUserId: access.session.user.id,
      seriesId: series,
      seriesCount: booked.length,
    });
    const told = input.sendDates && booked.length >= MIN_SERIES ? await tellPatientSeries(c, access.clinicId, series) : false;
    revalidatePath(`/c/${slug}/patients/${patientId}`);
    return { seriesId: series, booked: booked.map((b) => b.startsAt), skipped, told };
  });
}

/**
 * Cancels this visit and every later one of its series still to come. The
 * ones already seen, missed or cancelled are left as they are.
 */
export async function cancelSeriesFromAction(slug: string, appointmentId: string): Promise<{ error?: string; cancelled?: number }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!isUuid(appointmentId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const cur = (
      await c.query(`select series_id, starts_at, patient_id from appointments where id = $1 and clinic_id = $2`, [appointmentId, access.clinicId])
    ).rows[0];
    if (!cur?.series_id) return { error: "not_found" };
    const rest = (
      await c.query(
        `select id from appointments
          where clinic_id = $1 and series_id = $2 and starts_at >= $3 and status in ${HOLDS_SLOT}
          order by starts_at`,
        [access.clinicId, cur.series_id, cur.starts_at]
      )
    ).rows as { id: string }[];
    let cancelled = 0;
    for (const r of rest) {
      const x = await applyAppointmentStatus(c, {
        clinicId: access.clinicId,
        appointmentId: r.id,
        status: "cancelled",
        actorUserId: access.session.user.id,
      });
      if (x.ok && x.changed) cancelled++;
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.series_cancel_rest",
      entity: "appointment",
      entityId: appointmentId,
      detail: { seriesId: cur.series_id, ids: rest.map((r) => r.id) },
    });
    revalidatePath(`/c/${slug}/patients/${cur.patient_id}`);
    return { cancelled };
  });
}
