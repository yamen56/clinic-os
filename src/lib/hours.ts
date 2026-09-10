import { DateTime } from "luxon";

/** Weekly hours: per weekday, a list of [open, close] ranges in clinic-local "HH:mm". */
export type WeeklyHours = Record<string, [string, string][]>;

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function dayKey(dt: DateTime): string {
  // luxon: 1 = Monday … 7 = Sunday
  return DAY_KEYS[dt.weekday % 7];
}

export function rangesForDay(hours: WeeklyHours | null | undefined, dt: DateTime): [string, string][] {
  if (!hours) return [];
  return hours[dayKey(dt)] ?? [];
}

/** Minutes since local midnight for "HH:mm". */
export function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function isWithinHours(hours: WeeklyHours | null | undefined, start: DateTime, end: DateTime): boolean {
  const ranges = rangesForDay(hours, start);
  if (!ranges.length) return false;
  const s = start.hour * 60 + start.minute;
  const e = end.hour * 60 + end.minute || 24 * 60;
  return ranges.some(([o, c]) => s >= hmToMin(o) && e <= hmToMin(c));
}

/**
 * The overlap of two lists of ranges on one day.
 *
 * Both sides are short — a day has one or two ranges — so the pairwise loop is
 * the whole algorithm. An empty result means the two never coincide, which is
 * the correct answer for a doctor whose hours fall entirely outside the
 * clinic's.
 */
function overlap(a: [string, string][], b: [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  for (const [aOpen, aClose] of a) {
    for (const [bOpen, bClose] of b) {
      const open = Math.max(hmToMin(aOpen), hmToMin(bOpen));
      const close = Math.min(hmToMin(aClose), hmToMin(bClose));
      if (close > open) out.push([minToHm(open), minToHm(close)]);
    }
  }
  return out.sort((x, y) => hmToMin(x[0]) - hmToMin(y[0]));
}

function minToHm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * A doctor's bookable hours: their own, bounded by the clinic's.
 *
 * This used to return the doctor's hours *instead of* the clinic's, which made
 * a member's row able to open the practice. It did: a doctor on the demo
 * workspace had Sunday saved as 00:00–17:00, and the public page duly offered
 * appointments from midnight — thirty-four slots on Sunday against sixteen on
 * every other day, at hours when nobody is in the building.
 *
 * The clinic's opening hours are the outer bound now. A doctor can be available
 * for less than the clinic is open, never for more: reception, the door and the
 * chair are the clinic's, so an hour the clinic is shut is not an hour anyone
 * can be seen in. A clinic that genuinely runs an evening list widens its own
 * hours, which is the honest place to say so.
 *
 * A doctor with no hours of their own still simply takes the clinic's. A day
 * missing from their map stays closed for them — that is a doctor who does not
 * work Saturdays, not an oversight to be filled in from the clinic.
 */
export function effectiveHours(
  clinicHours: WeeklyHours,
  doctorHours: WeeklyHours | null | undefined
): WeeklyHours {
  if (!doctorHours || Object.keys(doctorHours).length === 0) return clinicHours;
  const out: WeeklyHours = {};
  for (const day of DAY_KEYS) {
    out[day] = overlap(doctorHours[day] ?? [], clinicHours[day] ?? []);
  }
  return out;
}

export function isBlockedDate(blocked: string[] | null | undefined, dt: DateTime): boolean {
  return !!blocked?.includes(dt.toISODate()!);
}
