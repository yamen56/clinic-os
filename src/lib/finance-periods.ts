/**
 * The stretches of time the Analytics tab can be asked about.
 *
 * Three named ones — this month, this year, all time — and any single month or
 * year, picked from one menu (Yamen, 2026-11-15: "any time … this month, this
 * year, all time, a specific month — don't put too many options"). In the URL
 * as `?p=month|year|all|2026-10|2025`.
 *
 * Apart from `lib/finance-analytics` for the reason `lib/finance` is apart from
 * `lib/finance-access`: the period controls are a client component, and
 * importing from the file that holds the queries would ship every statement in
 * it to the browser.
 */
export const PRESETS = ["month", "year", "all"] as const;
export type Preset = (typeof PRESETS)[number];

/** How the period's chart is cut up. */
export type Bucket = "day" | "month" | "year";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR = /^(\d{4})$/;

/** A URL parameter, read as a period. Anything else is this month. */
export function asPeriodParam(v: unknown): string {
  const s = String(v ?? "");
  if ((PRESETS as readonly string[]).includes(s)) return s;
  const y = Number((MONTH.exec(s) ?? YEAR.exec(s))?.[1]);
  return y >= 2000 && y <= 2100 ? s : "month";
}

/** `2026-10` → [2026, 10]; `2025` → [2025, null]; a preset → null. */
export function parsePeriodParam(p: string): { year: number; month: number | null } | null {
  const m = MONTH.exec(p);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  const y = YEAR.exec(p);
  return y ? { year: Number(y[1]), month: null } : null;
}
