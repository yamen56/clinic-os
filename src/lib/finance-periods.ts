/**
 * The stretches of time the Analytics tab can be asked about.
 *
 * Apart from `lib/finance-analytics` for the reason `lib/finance` is apart from
 * `lib/finance-access`: the period chips are a client component, and importing
 * a constant from the file that holds the queries would ship every statement
 * in it to the browser.
 */
export const PERIODS = ["month", "last", "3m", "6m", "12m", "year"] as const;
export type PeriodKey = (typeof PERIODS)[number];
/** How the period's chart is cut up. */
export type Bucket = "day" | "week" | "month";

/** A URL parameter, read as a period. Anything unknown is this month. */
export function asPeriodKey(v: unknown): PeriodKey {
  return (PERIODS as readonly string[]).includes(String(v)) ? (v as PeriodKey) : "month";
}
