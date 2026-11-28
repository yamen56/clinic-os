"use server";

/*
  What is wrong with a time before the desk saves it.

  Staff booking has never refused a doctor's day off or an hour outside their
  week — reception knows things the system does not ("she's coming in for this
  one") — and that stays. What it lacked was saying so: the calendar greyed the
  column, but a time typed into the panel for next month was booked without a
  word, and the desk found out when the doctor did not come in.

  So the panel asks here as the date, time, doctor or length change, and shows
  the answer under the time. Saving is still the desk's call; a clash with
  another patient is still refused on save, and only announced early here.
*/

import { DateTime } from "luxon";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { effectiveHours, isWithinHours, rangesForDay, type WeeklyHours } from "@/lib/hours";
import { HOLDS_SLOT } from "@/lib/rooms";
import { isUuid } from "@/lib/uuid";

export type SlotNotice =
  /** The doctor already has somebody then — refused on save; said now. */
  | { kind: "busy"; with: string }
  /** The doctor's day off (0124). */
  | { kind: "off"; note: string }
  /** The clinic is shut that day: a blocked date, or no opening hours on that weekday. */
  | { kind: "closed" }
  /** The doctor does not work that weekday. */
  | { kind: "not_working" }
  /** Outside the hours of that day — the doctor's within the clinic's, or the clinic's with no doctor. */
  | { kind: "outside"; hours: [string, string][] };

export async function slotNoticeAction(
  slug: string,
  input: { doctorMemberId: string | null; startsAt: string; endsAt: string; excludeId?: string | null }
): Promise<{ notice: SlotNotice | null }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { notice: null };
  const tz = access.clinic.timezone;
  const s = DateTime.fromISO(String(input.startsAt), { zone: "utc" }).setZone(tz);
  const e = DateTime.fromISO(String(input.endsAt), { zone: "utc" }).setZone(tz);
  if (!s.isValid || !e.isValid || e <= s) return { notice: null };
  const doctor = input.doctorMemberId && isUuid(input.doctorMemberId) ? input.doctorMemberId : null;
  const exclude = input.excludeId && isUuid(input.excludeId) ? input.excludeId : null;
  const day = s.toISODate()!;

  return inClinic(access, async (c) => {
    if (doctor) {
      const clash = (
        await c.query(
          `select p.full_name from appointments a join patients p on p.id = a.patient_id
            where a.clinic_id = $1 and a.doctor_member_id = $2 and a.status in ${HOLDS_SLOT}
              and a.starts_at < $4 and a.ends_at > $3 and ($5::uuid is null or a.id <> $5)
            limit 1`,
          [access.clinicId, doctor, s.toUTC().toISO(), e.toUTC().toISO(), exclude]
        )
      ).rows[0];
      if (clash) return { notice: { kind: "busy", with: clash.full_name as string } };
      const off = (
        await c.query(
          `select note from doctor_time_off where clinic_id = $1 and member_id = $2 and starts_on <= $3::date and ends_on >= $3::date limit 1`,
          [access.clinicId, doctor, day]
        )
      ).rows[0];
      if (off) return { notice: { kind: "off", note: (off.note as string) ?? "" } };
    }
    const clinic = (await c.query(`select working_hours, blocked_dates from clinics where id = $1`, [access.clinicId])).rows[0];
    const clinicHours = (clinic?.working_hours ?? {}) as WeeklyHours;
    if (((clinic?.blocked_dates ?? []) as string[]).includes(day) || !rangesForDay(clinicHours, s).length) return { notice: { kind: "closed" } };
    let hours = clinicHours;
    if (doctor) {
      const m = (await c.query(`select working_hours from clinic_members where id = $1 and clinic_id = $2`, [doctor, access.clinicId])).rows[0];
      hours = effectiveHours(clinicHours, (m?.working_hours ?? null) as WeeklyHours | null);
      if (!rangesForDay(hours, s).length) return { notice: { kind: "not_working" } };
    }
    if (!isWithinHours(hours, s, e)) return { notice: { kind: "outside", hours: rangesForDay(hours, s) } };
    return { notice: null };
  });
}
