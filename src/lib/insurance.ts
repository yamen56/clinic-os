import { round2 } from "./invoices";

/**
 * Insurance at the desk: who covers a patient, whether that cover still holds,
 * and how much of a bill the company pays.
 *
 * Pure and importable from the browser — the patient file, the invoice and the
 * claims screen all answer these questions, and three versions of "is this
 * cover still valid" would be three different answers within a month.
 *
 * Dates are `yyyy-MM-dd` strings in the clinic's own timezone. A `date` column
 * read through node-pg arrives as a JS Date in the server's zone, which moves it
 * by a day for half the world, so callers select `::text` and pass the clinic's
 * today alongside it.
 */

/** A company's standing terms with this clinic. Null percent means no rule. */
export type CoverageRule = { percent: number | null; cap: number | null };

export function ruleOf(row: { coverage_percent?: unknown; coverage_cap?: unknown } | null | undefined): CoverageRule {
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return { percent: num(row?.coverage_percent), cap: num(row?.coverage_cap) };
}

export function hasRule(rule: CoverageRule): boolean {
  return rule.percent !== null && rule.percent > 0;
}

/**
 * What the company pays of an invoice under the clinic's rule: the percentage,
 * held under the cap, never more than the invoice. Zero when there is no rule —
 * the amount then waits for a person, which is how every clinic worked before
 * rules existed and how a clinic that never sets one still does.
 */
export function insurerShareFor(total: number, rule: CoverageRule): number {
  if (!hasRule(rule) || !(total > 0)) return 0;
  let share = round2((total * Math.min(rule.percent!, 100)) / 100);
  if (rule.cap !== null && rule.cap >= 0) share = Math.min(share, round2(rule.cap));
  return Math.min(share, round2(total));
}

/** How close a cover is to running out before the file starts saying so. */
export const EXPIRING_DAYS = 30;

export type CoverState = "none" | "active" | "expiring" | "expired";

/**
 * Whether a patient's cover holds on a given day.
 *
 * No end date is "active": the clinic did not record one, and treating that as
 * lapsed would flag every insured patient on a file nobody finished typing.
 */
export function coverState(insurerId: string | null | undefined, validUntil: string | null | undefined, today: string): CoverState {
  if (!insurerId) return "none";
  if (!validUntil) return "active";
  const v = validUntil.slice(0, 10);
  if (v < today) return "expired";
  const days = (Date.parse(`${v}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= EXPIRING_DAYS ? "expiring" : "active";
}

/** Whether an invoice raised on `today` may take the company's share. */
export function coverHolds(insurerId: string | null | undefined, validUntil: string | null | undefined, today: string): boolean {
  const s = coverState(insurerId, validUntil, today);
  return s === "active" || s === "expiring";
}

/** The claims a clinic is still waiting on, as opposed to settled or never made. */
export const OPEN_CLAIM_STATUSES = ["to_submit", "submitted", "approved", "rejected"] as const;
export const CLAIM_STATUSES = ["none", "to_submit", "submitted", "approved", "rejected", "paid"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Which age bucket an open claim sits in, by the invoice's issue date. */
export function ageBucket(issueDate: string, today: string): "d30" | "d60" | "d90" | "older" {
  const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${issueDate.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return "older";
}
