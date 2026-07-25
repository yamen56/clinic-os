import { DateTime } from "luxon";

/** All storage is UTC; display is clinic-timezone. These helpers are the only path between the two. */

export function clinicNow(tz: string): DateTime {
  return DateTime.now().setZone(tz);
}

/** UTC ISO range [start, end) of a clinic-local day. `day` is 'yyyy-MM-dd' in clinic time. */
export function dayRangeUtc(tz: string, day?: string): { start: string; end: string; day: string } {
  const d = day
    ? DateTime.fromISO(day, { zone: tz })
    : DateTime.now().setZone(tz);
  const start = d.startOf("day");
  return {
    start: start.toUTC().toISO()!,
    end: start.plus({ days: 1 }).toUTC().toISO()!,
    day: start.toISODate()!,
  };
}

export function weekRangeUtc(tz: string, offsetWeeks = 0): { start: string; end: string } {
  const start = DateTime.now().setZone(tz).startOf("week").plus({ weeks: offsetWeeks });
  return { start: start.toUTC().toISO()!, end: start.plus({ weeks: 1 }).toUTC().toISO()! };
}

export function monthRangeUtc(tz: string): { start: string; end: string } {
  const start = DateTime.now().setZone(tz).startOf("month");
  return { start: start.toUTC().toISO()!, end: start.plus({ months: 1 }).toUTC().toISO()! };
}

const numLocale = (locale: string) => (locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB");

export function fmtTime(iso: string | Date, tz: string, locale: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).setLocale(numLocale(locale)).toFormat("h:mm a");
}

export function fmtDate(iso: string | Date, tz: string, locale: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).setLocale(numLocale(locale)).toFormat("d LLL yyyy");
}

export function fmtDateTime(iso: string | Date, tz: string, locale: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).setLocale(numLocale(locale)).toFormat("d LLL · h:mm a");
}

export function fmtRelative(iso: string | Date, locale: string): string {
  return (
    DateTime.fromJSDate(new Date(iso)).setLocale(numLocale(locale)).toRelative({ style: "short" }) ?? ""
  );
}

export function fmtMoney(n: number | string, currency: string, locale: string): string {
  const v = Number(n) || 0;
  return `${v.toLocaleString(numLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
