import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { effectiveHours, rangesForDay, hmToMin, type WeeklyHours } from "./hours";

export type SlotResult = { startISO: string; doctorMemberId: string | null };

/**
 * Availability engine for a booking link:
 * clinic/doctor working hours − blocked dates − existing appointments − buffers,
 * respecting min notice, max days ahead, and slot granularity.
 */
export async function computeSlots(
  c: PoolClient,
  opts: {
    clinicId: string;
    tz: string;
    clinicHours: WeeklyHours;
    blockedDates: string[];
    serviceId: string;
    doctorMemberId: string | null; // null = any doctor
    dateISO: string; // clinic-local date
    minNoticeMin: number;
    granularityMin: number;
    linkDoctorId: string | null; // link restriction
  }
): Promise<SlotResult[]> {
  const {
    clinicId, tz, clinicHours, blockedDates, serviceId, dateISO,
    minNoticeMin, granularityMin,
  } = opts;

  const day = DateTime.fromISO(dateISO, { zone: tz });
  if (!day.isValid || blockedDates.includes(day.toISODate()!)) return [];

  const service = (
    await c.query(
      `select duration_min, buffer_after_min from services where id = $1 and clinic_id = $2 and active`,
      [serviceId, clinicId]
    )
  ).rows[0];
  if (!service) return [];
  const durMin = service.duration_min as number;
  const bufMin = service.buffer_after_min as number;

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

  const dayStart = day.startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });
  const busy = (
    await c.query(
      `select doctor_member_id, starts_at, ends_at from appointments
       where clinic_id = $1 and status in ('pending_approval', 'scheduled', 'confirmed')
         and starts_at < $3 and ends_at > $2`,
      [clinicId, dayStart.toUTC().toISO(), dayEnd.toUTC().toISO()]
    )
  ).rows as { doctor_member_id: string | null; starts_at: Date; ends_at: Date }[];

  const earliest = DateTime.now().setZone(tz).plus({ minutes: minNoticeMin });
  const results: SlotResult[] = [];
  const seen = new Set<string>();

  const candidates = useUnassigned
    ? [{ id: null as string | null, working_hours: null as WeeklyHours | null }]
    : doctors;

  for (const doc of candidates) {
    const hours = effectiveHours(clinicHours, doc.working_hours);
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
        cursor = cursor.plus({ minutes: granularityMin });
      }
    }
  }
  results.sort((a, b) => a.startISO.localeCompare(b.startISO));
  return results;
}
