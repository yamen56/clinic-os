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

/** A doctor's effective hours: their own if set, otherwise the clinic's. */
export function effectiveHours(
  clinicHours: WeeklyHours,
  doctorHours: WeeklyHours | null | undefined
): WeeklyHours {
  return doctorHours && Object.keys(doctorHours).length > 0 ? doctorHours : clinicHours;
}

export function isBlockedDate(blocked: string[] | null | undefined, dt: DateTime): boolean {
  return !!blocked?.includes(dt.toISODate()!);
}
