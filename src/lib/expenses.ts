import type { PoolClient } from "pg";
import { clinicNetRevenue } from "./earnings";

/**
 * What the clinic spent.
 *
 * Kept apart from `src/lib/earnings.ts` on purpose, and the reason is a
 * measurement one rather than tidiness. Everything in that file is keyed on
 * `payments.paid_at`, a `timestamptz`, and scoped by UTC instants. An expense is
 * keyed on `spent_on`, a `date` — the day written on the receipt. Mixing the two
 * in one function would mean one of them is filtered with the wrong kind of
 * bound, and the failure is silent: for Asia/Amman a month "starts" at
 * 21:00 the previous day, so the 31st of August lands in September's expenses
 * and nobody can see why the totals moved.
 *
 * So: instants for money in, calendar dates for money out, and `clinicProfit`
 * below is the only place the two meet.
 */

export type ExpenseScope = {
  clinicId: string;
  /** Inclusive, `yyyy-MM-dd`, from `monthDateRange`. */
  from: string;
  /** Exclusive, `yyyy-MM-dd`. */
  to: string;
};

export type ExpenseRow = {
  id: string;
  amount: number;
  vendor: string;
  note: string;
  spentOn: string;
  method: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryNameAr: string | null;
  categoryColor: string | null;
  hasReceipt: boolean;
  /** Posted by a recurring rule rather than typed by somebody. */
  recurring: boolean;
};

export type ExpenseCategoryTotal = {
  categoryId: string | null;
  name: string | null;
  nameAr: string | null;
  color: string | null;
  total: number;
};

/** The month's spend, as one number. */
export async function clinicExpenses(c: PoolClient, scope: ExpenseScope): Promise<number> {
  const r = await c.query(
    `select coalesce(sum(amount), 0) as total
       from expenses
      where clinic_id = $1 and spent_on >= $2::date and spent_on < $3::date`,
    [scope.clinicId, scope.from, scope.to]
  );
  return Number(r.rows[0].total);
}

/** The same month, broken down — what the screen draws its bars from. */
export async function expensesByCategory(
  c: PoolClient,
  scope: ExpenseScope
): Promise<ExpenseCategoryTotal[]> {
  const r = await c.query(
    `select e.category_id, ec.name, ec.name_ar, ec.color,
            coalesce(sum(e.amount), 0) as total
       from expenses e
       left join expense_categories ec on ec.id = e.category_id
      where e.clinic_id = $1 and e.spent_on >= $2::date and e.spent_on < $3::date
      group by e.category_id, ec.name, ec.name_ar, ec.color
      order by total desc`,
    [scope.clinicId, scope.from, scope.to]
  );
  return r.rows.map((row) => ({
    categoryId: row.category_id as string | null,
    name: row.name as string | null,
    nameAr: row.name_ar as string | null,
    color: row.color as string | null,
    total: Number(row.total),
  }));
}

/** The month's expenses, newest first. */
export async function listExpenses(c: PoolClient, scope: ExpenseScope): Promise<ExpenseRow[]> {
  const r = await c.query(
    `select e.id, e.amount, e.vendor, e.note, e.spent_on, e.method,
            e.category_id, e.receipt_path is not null as has_receipt,
            e.schedule_id is not null as recurring,
            ec.name, ec.name_ar, ec.color
       from expenses e
       left join expense_categories ec on ec.id = e.category_id
      where e.clinic_id = $1 and e.spent_on >= $2::date and e.spent_on < $3::date
      order by e.spent_on desc, e.created_at desc
      limit 500`,
    [scope.clinicId, scope.from, scope.to]
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    amount: Number(row.amount),
    vendor: row.vendor as string,
    note: row.note as string,
    // A `date` comes back from node-pg as a JS Date at the *server's* midnight.
    // Handing the bare ISO day onward keeps every reader away from a timezone
    // conversion that would move it.
    spentOn: toISODate(row.spent_on),
    method: row.method as string,
    categoryId: row.category_id as string | null,
    categoryName: row.name as string | null,
    categoryNameAr: row.name_ar as string | null,
    categoryColor: row.color as string | null,
    hasReceipt: row.has_receipt === true,
    recurring: row.recurring === true,
  }));
}

/**
 * What the clinic actually kept.
 *
 * The one place money in and money out are measured together, and every line is
 * a figure an owner recognises rather than a composite:
 *
 *   collected        what the patients paid, tax included
 *   tax              the part of it that belongs to the tax authority
 *   commission       the doctors' shares
 *   expenses         what the clinic spent
 *   kept             the remainder, and it may well be negative
 *
 * **Tax is subtracted because otherwise the sign can be wrong.** A clinic that
 * collects 10,000 and spends 9,000 looks 1,000 ahead until you remember that
 * ~1,379 of that was never theirs — the truth is a small loss. A figure that
 * reports a profit in a losing month is not a labelling problem.
 *
 * **Expenses are recorded tax-inclusive** — what actually left the bank — and no
 * input tax is reclaimed here. That is deliberate rather than unfinished: input
 * recovery depends on a valid tax invoice from a registered supplier *and* on
 * the clinic's own supplies being taxable, and half of that feature is worse
 * than none of it. The result is exact for an unregistered clinic, which is
 * almost all of them, and conservative for a registered one.
 */
export async function clinicProfit(
  c: PoolClient,
  args: {
    clinicId: string;
    /** Instants, for the payments side. */
    from: Date;
    to: Date;
    /** Calendar dates, for the expenses side. Same month, different units. */
    fromDate: string;
    toDate: string;
  }
): Promise<{
  collected: number;
  tax: number;
  commission: number;
  expenses: number;
  kept: number;
  /** The same chain stopping before expenses, for a reader who may not see them. */
  afterCommission: number;
}> {
  const net = await clinicNetRevenue(c, {
    clinicId: args.clinicId,
    from: args.from,
    to: args.to,
  });
  const expenses = await clinicExpenses(c, {
    clinicId: args.clinicId,
    from: args.fromDate,
    to: args.toDate,
  });
  return {
    collected: net.gross,
    tax: net.tax,
    commission: net.commission,
    expenses,
    kept: round2(net.gross - net.tax - net.commission - expenses),
    afterCommission: round2(net.gross - net.tax - net.commission),
  };
}

/** Does this clinic record any spending at all? Decides whether the lines render. */
export async function clinicHasExpenses(c: PoolClient, clinicId: string): Promise<boolean> {
  const r = await c.query(`select 1 from expenses where clinic_id = $1 limit 1`, [clinicId]);
  return (r.rowCount ?? 0) > 0;
}

function toISODate(v: unknown): string {
  if (v instanceof Date) {
    // Local parts, not toISOString(): the value is a calendar day and UTC
    // conversion is exactly what moves it.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
