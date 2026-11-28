import type { PoolClient } from "pg";
import { fmtDateOnly } from "./dates";

/**
 * Doctors' days off (migration 0124): inclusive ranges of the clinic's own
 * calendar days. The slot engine reads them itself (lib/slots); this is what
 * the pages and the calendar list.
 */

export type TimeOffRow = {
  id: string;
  member_id: string;
  doctor_name: string;
  /** yyyy-MM-dd, inclusive. */
  starts_on: string;
  ends_on: string;
  note: string;
};

const SELECT = `
  select t.id, t.member_id, u.full_name as doctor_name,
         t.starts_on::text as starts_on, t.ends_on::text as ends_on, t.note
    from doctor_time_off t
    join clinic_members m on m.id = t.member_id
    join users u on u.id = m.user_id`;

/** Days off that have not ended yet, soonest first — for one doctor, or every doctor. */
export async function loadUpcomingTimeOff(
  c: PoolClient,
  clinicId: string,
  today: string,
  memberId?: string | null
): Promise<TimeOffRow[]> {
  const r = await c.query(
    `${SELECT}
      where t.clinic_id = $1 and t.ends_on >= $2::date and ($3::uuid is null or t.member_id = $3)
      order by t.starts_on, u.full_name
      limit 200`,
    [clinicId, today, memberId ?? null]
  );
  return r.rows as TimeOffRow[];
}

/** Days off touching a window of days, for the calendar. */
export async function loadTimeOffBetween(
  c: PoolClient,
  clinicId: string,
  fromDay: string,
  toDay: string
): Promise<TimeOffRow[]> {
  const r = await c.query(
    `${SELECT}
      where t.clinic_id = $1 and t.ends_on >= $2::date and t.starts_on <= $3::date
      order by t.starts_on`,
    [clinicId, fromDay, toDay]
  );
  return r.rows as TimeOffRow[];
}

/** "3 Dec 2026", or "3 Dec 2026 – 7 Dec 2026". */
export function timeOffRangeText(from: string, to: string, locale: string): string {
  return from === to ? fmtDateOnly(from, locale) : `${fmtDateOnly(from, locale)} – ${fmtDateOnly(to, locale)}`;
}

/** Whether a member is off on a yyyy-MM-dd day. */
export function offOn(rows: Pick<TimeOffRow, "member_id" | "starts_on" | "ends_on">[], memberId: string, day: string) {
  return rows.find((r) => r.member_id === memberId && r.starts_on <= day && day <= r.ends_on) ?? null;
}
