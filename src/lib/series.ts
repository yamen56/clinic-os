import { DateTime } from "luxon";

/**
 * Repeating appointments (migration 0126): the dates a series falls on.
 *
 * Counted on the clinic's own calendar, so a visit at 10:00 stays at 10:00
 * every time. A month is a calendar month — the 31st becomes the last day of
 * a shorter month rather than spilling into the next one, which is what
 * luxon's month arithmetic does already.
 */

export type RepeatUnit = "day" | "week" | "month";
export type Repeat = { every: number; unit: RepeatUnit };

/** The most one series books. A course longer than this is booked again when it runs out. */
export const MAX_SERIES = 20;
export const MIN_SERIES = 2;

/** The three the desk reaches for, one press each. */
export const REPEAT_PRESETS: Repeat[] = [
  { every: 1, unit: "week" },
  { every: 2, unit: "week" },
  { every: 4, unit: "week" },
];

/** And the rest, behind one menu. */
export const REPEAT_MORE: Repeat[] = [
  { every: 2, unit: "day" },
  { every: 3, unit: "day" },
  { every: 3, unit: "week" },
  { every: 6, unit: "week" },
  { every: 8, unit: "week" },
  { every: 1, unit: "month" },
  { every: 2, unit: "month" },
  { every: 3, unit: "month" },
  { every: 6, unit: "month" },
];

export function repeatKey(r: Repeat): string {
  return `${r.every}:${r.unit}`;
}

export function parseRepeat(raw: unknown): Repeat | null {
  if (!raw || typeof raw !== "object") return null;
  const { every, unit } = raw as Record<string, unknown>;
  const n = Number(every);
  if (!Number.isInteger(n) || n < 1 || n > 90) return null;
  if (unit !== "day" && unit !== "week" && unit !== "month") return null;
  return { every: n, unit };
}

/**
 * The start of each visit, the first one first: `count` of them, `first` and
 * then one every `every` units after it, each at the same clinic-local time.
 */
export function seriesStarts(first: DateTime, repeat: Repeat, count: number): DateTime[] {
  const n = Math.max(1, Math.min(MAX_SERIES, Math.floor(count)));
  const out: DateTime[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      repeat.unit === "month"
        ? first.plus({ months: i * repeat.every })
        : repeat.unit === "week"
          ? first.plus({ weeks: i * repeat.every })
          : first.plus({ days: i * repeat.every })
    );
  }
  return out;
}

export type RepeatWords = {
  everyDay: string;
  everyTwoDays: string;
  everyDays: string;
  everyWeek: string;
  everyTwoWeeks: string;
  everyWeeks: string;
  everyMonth: string;
  everyTwoMonths: string;
  everyMonths: string;
};

/**
 * "Every 4 weeks", "Every month", "Every 3 days" — in the dictionary's words.
 * Two has its own form because Arabic says it with the dual (كل أسبوعين), not
 * a number; the menu goes no higher than ten, so the plural covers the rest.
 */
export function repeatLabel(r: Repeat, w: RepeatWords): string {
  const [one, two, many] =
    r.unit === "day"
      ? [w.everyDay, w.everyTwoDays, w.everyDays]
      : r.unit === "week"
        ? [w.everyWeek, w.everyTwoWeeks, w.everyWeeks]
        : [w.everyMonth, w.everyTwoMonths, w.everyMonths];
  return (r.every === 1 ? one : r.every === 2 ? two : many).replace("{n}", String(r.every));
}
