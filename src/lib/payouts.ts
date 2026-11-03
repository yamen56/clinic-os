import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { earningsByDoctorMonth } from "./earnings";
import { round2 } from "./invoices";

/**
 * What the clinic has handed its doctors (0091), and what it still owes them.
 *
 * A payout is money paid for one month. What that month still owes is its
 * earnings, read live by `lib/earnings` exactly as the earnings screen reads
 * them, less the payouts recorded against it — never a stored "paid" flag,
 * because a month's share can still move after it was paid: an instalment
 * dated into it, a lab bill corrected, an invoice cancelled. The difference
 * then shows as owed again (or as paid over), which is the truth.
 */

/** How a clinic pays a doctor. Not a card: nobody pays a colleague by card. */
export const PAYOUT_METHODS = ["cash", "cliq", "transfer", "cheque"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export type Payout = {
  id: string;
  doctorMemberId: string;
  /** The month it pays for, as its first day: `YYYY-MM-01`. */
  period: string;
  amount: number;
  /** The day the money changed hands, `YYYY-MM-DD`. */
  paidOn: string;
  method: PayoutMethod;
  note: string;
};

/** Below a fil is rounding, not a debt. */
export const SETTLED = 0.005;

/** The month `offset` months from this one, as its first day in the clinic's calendar. */
export function periodOf(timezone: string, offset: number): string {
  return DateTime.now().setZone(timezone).startOf("month").plus({ months: offset }).toISODate()!;
}

/** How many months from this one a `YYYY-MM` is — the earnings screen's `?m=`. */
export function offsetOf(timezone: string, month: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const now = DateTime.now().setZone(timezone);
  return (Number(m[1]) - now.year) * 12 + (Number(m[2]) - now.month);
}

/** The payouts recorded for one month — the clinic's, or one doctor's. */
export async function payoutsForPeriod(
  c: PoolClient,
  clinicId: string,
  period: string,
  doctorMemberId?: string
): Promise<Payout[]> {
  const r = await c.query(
    `select id, doctor_member_id, to_char(period, 'YYYY-MM-DD') as period, amount,
            to_char(paid_on, 'YYYY-MM-DD') as paid_on, method, note
       from doctor_payouts
      where clinic_id = $1 and period = $2::date
        and ($3::uuid is null or doctor_member_id = $3::uuid)
      order by paid_on, created_at`,
    [clinicId, period, doctorMemberId ?? null]
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    doctorMemberId: row.doctor_member_id as string,
    period: row.period as string,
    amount: Number(row.amount),
    paidOn: row.paid_on as string,
    method: row.method as PayoutMethod,
    note: (row.note as string) ?? "",
  }));
}

export type OwedMonth = {
  doctorMemberId: string;
  period: string;
  earned: number;
  paid: number;
  owed: number;
};

/**
 * Months gone by that a doctor is still owed for.
 *
 * Only from the first month the clinic paid that doctor through this screen.
 * Every clinic paid its doctors before payouts existed here, by hand, so every
 * month before that would read as owed and the list would be a wall of debts
 * nobody has. Once a clinic starts marking a doctor paid, a month after it left
 * unpaid is a month somebody forgot — which is what this list is for.
 *
 * Finished months only (the one under way is not due yet), at most a year
 * back, and never `except` — the month already on the screen says it itself.
 */
export async function owedEarlier(
  c: PoolClient,
  clinicId: string,
  timezone: string,
  except: string
): Promise<OwedMonth[]> {
  const firsts = new Map<string, string>(
    (
      await c.query(
        `select doctor_member_id, to_char(min(period), 'YYYY-MM-DD') as first
           from doctor_payouts where clinic_id = $1 group by 1`,
        [clinicId]
      )
    ).rows.map((r) => [r.doctor_member_id as string, r.first as string])
  );
  if (!firsts.size) return [];

  const until = periodOf(timezone, 0);
  const floor = periodOf(timezone, -12);
  const earliest = [...firsts.values()].sort()[0];
  const since = earliest > floor ? earliest : floor;
  if (since >= until) return [];

  const instant = (d: string) => DateTime.fromISO(d, { zone: timezone }).toJSDate();
  const earned = await earningsByDoctorMonth(c, { clinicId, from: instant(since), to: instant(until) }, timezone);
  const paid = new Map<string, number>(
    (
      await c.query(
        `select doctor_member_id, to_char(period, 'YYYY-MM-DD') as period, sum(amount) as paid
           from doctor_payouts
          where clinic_id = $1 and period >= $2::date and period < $3::date
          group by 1, 2`,
        [clinicId, since, until]
      )
    ).rows.map((r) => [`${r.doctor_member_id}|${r.period}`, Number(r.paid)])
  );

  return earned
    .filter((e) => e.period !== except && e.period >= (firsts.get(e.doctorMemberId) ?? "9999"))
    .map((e) => {
      const p = paid.get(`${e.doctorMemberId}|${e.period}`) ?? 0;
      return { ...e, paid: p, owed: round2(e.earned - p) };
    })
    .filter((e) => e.owed > SETTLED)
    .sort((a, b) => a.period.localeCompare(b.period));
}
