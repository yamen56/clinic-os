import { DateTime } from "luxon";

/** All storage is UTC; display is clinic-timezone. These helpers are the only path between the two. */

export function clinicNow(tz: string): DateTime {
  return DateTime.now().setZone(tz);
}

/** Today in the clinic, as 'yyyy-MM-dd' — the default and the latest a "when was it" field allows. */
export function todayIn(tz: string): string {
  return clinicNow(tz).toISODate()!;
}

/**
 * The instant to store for something that happened on a clinic day chosen by
 * hand — a payment taken, an invoice raised, a treatment done — because it is
 * often written down afterwards (Yamen, 2026-11-20: "many times I record a
 * payment or something else and it was not today").
 *
 * Today (or nothing chosen) is `null`: the caller stores now, exactly as
 * before. An earlier day is midday of that day in the clinic's timezone, so it
 * lands on that date whichever timezone reads it back. A day in the future,
 * more than ten years back, or not a date is refused.
 */
export function pastDayInstant(
  day: string | null | undefined,
  tz: string
): { ok: true; at: string | null } | { ok: false } {
  if (!day) return { ok: true, at: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false };
  const d = DateTime.fromISO(day, { zone: tz });
  if (!d.isValid) return { ok: false };
  const today = clinicNow(tz).startOf("day");
  if (d.startOf("day") > today || d < today.minus({ years: 10 })) return { ok: false };
  if (d.hasSame(today, "day")) return { ok: true, at: null };
  return { ok: true, at: d.set({ hour: 12, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()! };
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

export function monthRangeUtc(tz: string, offsetMonths = 0): { start: string; end: string } {
  const start = DateTime.now().setZone(tz).startOf("month").plus({ months: offsetMonths });
  return { start: start.toUTC().toISO()!, end: start.plus({ months: 1 }).toUTC().toISO()! };
}

/**
 * The same month, as plain calendar dates rather than instants.
 *
 * `monthRangeUtc` is right for a `timestamptz` column and wrong for a `date`
 * one. For Asia/Amman it returns `…-08-31T21:00:00Z` as the start of September,
 * and comparing a `date` against that casts under the session's TimeZone —
 * which nothing here sets — quietly pulling the 31st of August into September's
 * total. Anything filtering `expenses.spent_on` or `invoices.issue_date` wants
 * these two strings instead, half-open like every other range in this file.
 */
export function monthDateRange(
  tz: string,
  offsetMonths = 0
): { from: string; to: string } {
  const start = DateTime.now().setZone(tz).startOf("month").plus({ months: offsetMonths });
  return { from: start.toISODate()!, to: start.plus({ months: 1 }).toISODate()! };
}

/** The month's own name, for a screen that lets somebody step back through them. */
export function monthLabel(tz: string, offsetMonths: number, locale: string): string {
  return DateTime.now()
    .setZone(tz)
    .startOf("month")
    .plus({ months: offsetMonths })
    .setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB")
    .toFormat("LLLL yyyy");
}

const numLocale = (locale: string) => (locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB");

export function fmtTime(iso: string | Date, tz: string, locale: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).setLocale(numLocale(locale)).toFormat("h:mm a");
}

export function fmtDate(iso: string | Date, tz: string, locale: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).setLocale(numLocale(locale)).toFormat("d LLL yyyy");
}

/**
 * A calendar date that is already a calendar date.
 *
 * `fmtDate` converts an instant into a timezone, which is right for a timestamp
 * and wrong for a `date` column: node-pg hands one back as a JS Date at local
 * midnight, and pushing that through another zone moves it a day whenever the
 * server and the clinic disagree. An invoice's issue date is the date the clinic
 * wrote on it, not a moment to be re-interpreted.
 */
export function fmtDateOnly(d: string | Date, locale: string): string {
  const dt = typeof d === "string" ? DateTime.fromISO(d.slice(0, 10)) : DateTime.fromJSDate(d);
  return dt.setLocale(numLocale(locale)).toFormat("d LLL yyyy");
}

/** Today in the clinic, spelled out — "Monday 5 October" — for a page that is about today. */
export function fmtLongToday(tz: string, locale: string): string {
  return clinicNow(tz).setLocale(numLocale(locale)).toFormat("cccc d LLLL");
}

/**
 * A chat message's day, the way WhatsApp says it (Yamen, 2026-11-28: "we need
 * to see the date of sending the message like whatsapp"): Today, Yesterday,
 * the weekday within the past week, else the date — with the year only when
 * it is not this one. In the clinic's timezone, so a message at 00:30 Amman
 * time is not filed under the day before.
 */
export function chatDayLabel(iso: string | Date, tz: string, locale: string, w: { today: string; yesterday: string }): string {
  const d = DateTime.fromJSDate(new Date(iso)).setZone(tz).startOf("day");
  const today = clinicNow(tz).startOf("day");
  const days = Math.round(today.diff(d, "days").days);
  if (days === 0) return w.today;
  if (days === 1) return w.yesterday;
  const dt = d.setLocale(numLocale(locale));
  if (days > 1 && days < 7) return dt.toFormat("cccc");
  return dt.toFormat(d.year === today.year ? "cccc d LLLL" : "d LLLL yyyy");
}

/** The clinic-local day a message belongs to, for grouping a thread by day. */
export function chatDayKey(iso: string | Date, tz: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).toISODate() ?? "";
}

/**
 * The stamp beside a chat in the list, as WhatsApp's: the time today,
 * Yesterday, the weekday this past week, else the short date.
 */
export function chatListStamp(iso: string | Date, tz: string, locale: string, w: { yesterday: string }): string {
  const at = DateTime.fromJSDate(new Date(iso)).setZone(tz);
  const days = Math.round(clinicNow(tz).startOf("day").diff(at.startOf("day"), "days").days);
  const dt = at.setLocale(numLocale(locale));
  if (days <= 0) return dt.toFormat("h:mm a");
  if (days === 1) return w.yesterday;
  if (days < 7) return dt.toFormat("cccc");
  return dt.toFormat("d/M/yyyy");
}

export function fmtDateTime(iso: string | Date, tz: string, locale: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).setLocale(numLocale(locale)).toFormat("d LLL · h:mm a");
}

export function fmtRelative(iso: string | Date, locale: string): string {
  const dt = DateTime.fromJSDate(new Date(iso));
  /*
    Under a minute either way is "now". Luxon counts seconds literally, so a
    file opened this instant said "0 seconds ago", and a server clock a beat
    ahead of the browser's said "in 2 sec" about something that already
    happened. The platform's own word for it, in the reader's language.
  */
  if (Math.abs(dt.diffNow().as("seconds")) < 60) {
    return new Intl.RelativeTimeFormat(numLocale(locale), { numeric: "auto" }).format(0, "second");
  }
  return dt.setLocale(numLocale(locale)).toRelative({ style: "short" }) ?? "";
}

export function fmtMoney(n: number | string, currency: string, locale: string): string {
  const v = Number(n) || 0;
  return `${v.toLocaleString(numLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
