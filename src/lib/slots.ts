import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { effectiveHours, rangesForDay, hmToMin, type WeeklyHours } from "./hours";

export type SlotResult = { startISO: string; doctorMemberId: string | null };

type Candidate = { id: string | null; working_hours: WeeklyHours | null };
type Busy = { doctor_member_id: string | null; starts_at: Date; ends_at: Date };

type Inputs = {
  durMin: number;
  bufMin: number;
  candidates: Candidate[];
  useUnassigned: boolean;
  busy: Busy[];
};

export type AvailabilityOpts = {
  clinicId: string;
  tz: string;
  clinicHours: WeeklyHours;
  blockedDates: string[];
  serviceId: string;
  doctorMemberId: string | null; // null = any doctor
  minNoticeMin: number;
  granularityMin: number;
  linkDoctorId: string | null; // link restriction
};

/**
 * The three reads a free/busy scan needs, done once for a whole window.
 *
 * Split out because the calendar strip asks about thirty days at a time. Doing
 * this per day would be ninety round trips on one connection — node-pg
 * serialises them, so it is ninety latencies in a row — for data that does not
 * change between days.
 */
async function loadInputs(
  c: PoolClient,
  opts: AvailabilityOpts,
  fromUTC: string,
  toUTC: string
): Promise<Inputs | null> {
  const { clinicId, serviceId } = opts;

  const service = (
    await c.query(
      `select duration_min, buffer_after_min from services where id = $1 and clinic_id = $2 and active`,
      [serviceId, clinicId]
    )
  ).rows[0];
  if (!service) return null;

  // Candidate doctors: explicit > link restriction > doctors assigned to the service > any active doctor
  let doctors: { id: string; working_hours: WeeklyHours | null }[];
  const explicit = opts.doctorMemberId ?? opts.linkDoctorId;
  if (explicit) {
    doctors = (
      await c.query(
        `select id, working_hours from clinic_members where id = $1 and clinic_id = $2 and role = 'doctor' and active`,
        [explicit, clinicId]
      )
    ).rows;
  } else {
    doctors = (
      await c.query(
        `select cm.id, cm.working_hours from clinic_members cm
         where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active
           and (exists (select 1 from service_doctors sd where sd.service_id = $2 and sd.member_id = cm.id)
                or not exists (select 1 from service_doctors sd2 where sd2.service_id = $2))
         order by cm.created_at`,
        [clinicId, serviceId]
      )
    ).rows;
  }
  // Clinic without doctors: fall back to a single unassigned column of clinic hours
  const useUnassigned = doctors.length === 0;

  const busy = (
    await c.query(
      `select doctor_member_id, starts_at, ends_at from appointments
       where clinic_id = $1 and status in ('pending_approval', 'scheduled', 'confirmed')
         and starts_at < $3 and ends_at > $2`,
      [clinicId, fromUTC, toUTC]
    )
  ).rows as Busy[];

  return {
    durMin: service.duration_min as number,
    bufMin: service.buffer_after_min as number,
    candidates: useUnassigned ? [{ id: null, working_hours: null }] : doctors,
    useUnassigned,
    busy,
  };
}

/** One clinic-local day, computed in memory from already-loaded inputs. */
function slotsForDay(
  day: DateTime,
  input: Inputs,
  opts: Pick<AvailabilityOpts, "clinicHours" | "blockedDates" | "granularityMin">,
  earliest: DateTime
): SlotResult[] {
  if (opts.blockedDates.includes(day.toISODate()!)) return [];

  const { durMin, bufMin, candidates, useUnassigned, busy } = input;
  const dayStart = day.startOf("day");
  const results: SlotResult[] = [];
  const seen = new Set<string>();

  for (const doc of candidates) {
    const hours = effectiveHours(opts.clinicHours, doc.working_hours);
    for (const [open, close] of rangesForDay(hours, day)) {
      let cursor = dayStart.plus({ minutes: hmToMin(open) });
      const rangeEnd = dayStart.plus({ minutes: hmToMin(close) });
      while (cursor.plus({ minutes: durMin }) <= rangeEnd) {
        const slotEnd = cursor.plus({ minutes: durMin + bufMin });
        const key = cursor.toISO()!;
        if (cursor >= earliest && !seen.has(key)) {
          const conflict = busy.some((b) => {
            if (!useUnassigned && b.doctor_member_id && b.doctor_member_id !== doc.id) return false;
            if (!useUnassigned && !b.doctor_member_id) return false;
            const bs = DateTime.fromJSDate(new Date(b.starts_at));
            const be = DateTime.fromJSDate(new Date(b.ends_at));
            return cursor.toUTC() < be && slotEnd.toUTC() > bs;
          });
          if (!conflict) {
            seen.add(key);
            results.push({ startISO: cursor.toUTC().toISO()!, doctorMemberId: doc.id });
          }
        }
        cursor = cursor.plus({ minutes: opts.granularityMin });
      }
    }
  }
  results.sort((a, b) => a.startISO.localeCompare(b.startISO));
  return results;
}

/**
 * Availability engine for a booking link:
 * clinic/doctor working hours − blocked dates − existing appointments − buffers,
 * respecting min notice, max days ahead, and slot granularity.
 */
export async function computeSlots(
  c: PoolClient,
  opts: AvailabilityOpts & { dateISO: string }
): Promise<SlotResult[]> {
  const day = DateTime.fromISO(opts.dateISO, { zone: opts.tz });
  if (!day.isValid) return [];
  const dayStart = day.startOf("day");
  const input = await loadInputs(
    c,
    opts,
    dayStart.toUTC().toISO()!,
    dayStart.plus({ days: 1 }).toUTC().toISO()!
  );
  if (!input) return [];
  const earliest = DateTime.now().setZone(opts.tz).plus({ minutes: opts.minNoticeMin });
  return slotsForDay(day, input, opts, earliest);
}

/**
 * How many slots each day in a window still has, in one pass.
 *
 * This is what turns the date strip from a row of identical buttons into a
 * calendar. Without it the patient taps a day, waits, reads "no available
 * times", and taps the next one — on a clinic that opens three days a week
 * that is the whole booking experience. The counts are cheap because the
 * expensive parts (service, doctors, the busy scan) are loaded once for the
 * whole window and every day after that is arithmetic.
 */
export async function computeDayCounts(
  c: PoolClient,
  opts: AvailabilityOpts & { fromISO: string; days: number }
): Promise<Record<string, number>> {
  const first = DateTime.fromISO(opts.fromISO, { zone: opts.tz });
  if (!first.isValid || opts.days < 1) return {};
  const span = Math.min(opts.days, 62);
  const start = first.startOf("day");
  const input = await loadInputs(
    c,
    opts,
    start.toUTC().toISO()!,
    start.plus({ days: span }).toUTC().toISO()!
  );
  if (!input) return {};

  const earliest = DateTime.now().setZone(opts.tz).plus({ minutes: opts.minNoticeMin });
  const counts: Record<string, number> = {};
  for (let i = 0; i < span; i++) {
    const day = start.plus({ days: i });
    counts[day.toISODate()!] = slotsForDay(day, input, opts, earliest).length;
  }
  return counts;
}
