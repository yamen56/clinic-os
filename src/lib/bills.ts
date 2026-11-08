import type { PoolClient } from "pg";
import { round2 } from "./invoices";

/**
 * What the clinic owes its suppliers (ذمم, 0099).
 *
 * A bill is money owed; paying it writes an ordinary expense on the day the
 * money leaves, pointing back at the bill. What is still owed is the bill less
 * those expenses, read live — so a payment deleted in Expenses makes the bill
 * owed again, and nothing has to be kept in step.
 */

export type BillPayment = { id: string; amount: number; spentOn: string; method: string };

export type Bill = {
  id: string;
  companyId: string | null;
  vendor: string;
  categoryId: string | null;
  amount: number;
  paid: number;
  owed: number;
  incurredOn: string;
  dueOn: string | null;
  note: string;
  /** The delivery it is for, when it came with stock: the product's name. */
  product: string | null;
  payments: BillPayment[];
};

export type SupplierOwed = {
  /** The company's id, or the vendor's name folded — what the bills are grouped by. */
  key: string;
  name: string;
  owed: number;
  /** Oldest first, the order a payment settles them in. */
  bills: Bill[];
};

/** Below a fil is rounding, not a debt. */
export const SETTLED = 0.005;

/** Who a bill is owed to, as one key: the company when there is one, otherwise the name as typed. */
export const supplierKey = (b: { companyId: string | null; vendor: string }) =>
  b.companyId ?? `v:${b.vendor.trim().replace(/\s+/g, " ").toLowerCase()}`;

const BILLS_SQL = `
  select b.id, b.company_id, coalesce(co.name, b.vendor) as vendor, b.category_id, b.amount,
         to_char(b.incurred_on, 'YYYY-MM-DD') as incurred_on, to_char(b.due_on, 'YYYY-MM-DD') as due_on, b.note,
         (select p.name from stock_batches sb join aesthetic_products p on p.id = sb.product_id
           where sb.bill_id = b.id limit 1) as product,
         coalesce((select json_agg(json_build_object('id', e.id, 'amount', e.amount, 'spentOn', to_char(e.spent_on, 'YYYY-MM-DD'), 'method', e.method)
                                   order by e.spent_on, e.created_at)
                     from expenses e where e.bill_id = b.id), '[]'::json) as payments
    from supplier_bills b
    left join aesthetic_companies co on co.id = b.company_id
   where b.clinic_id = $1`;

function toBill(r: Record<string, unknown>): Bill {
  const payments = (r.payments as Record<string, unknown>[]).map((p) => ({
    id: p.id as string,
    amount: Number(p.amount),
    spentOn: p.spentOn as string,
    method: p.method as string,
  }));
  const amount = Number(r.amount);
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  return {
    id: r.id as string,
    companyId: (r.company_id as string) ?? null,
    vendor: (r.vendor as string) ?? "",
    categoryId: (r.category_id as string) ?? null,
    amount,
    paid,
    owed: round2(amount - paid),
    incurredOn: r.incurred_on as string,
    dueOn: (r.due_on as string) ?? null,
    note: (r.note as string) ?? "",
    product: (r.product as string) ?? null,
    payments,
  };
}

/** Every bill not yet paid in full, oldest first. */
export async function openBills(c: PoolClient, clinicId: string): Promise<Bill[]> {
  const r = await c.query(
    `select * from (${BILLS_SQL}) x
      where x.amount - coalesce((select sum(e.amount) from expenses e where e.bill_id = x.id), 0) > ${SETTLED}
      order by x.incurred_on, x.id`,
    [clinicId]
  );
  return r.rows.map(toBill);
}

/** Some bills by id, this clinic's only, oldest first — the ones a payment is being made toward. */
export async function billsById(c: PoolClient, clinicId: string, ids: string[]): Promise<Bill[]> {
  const r = await c.query(`select * from (${BILLS_SQL} and b.id = any($2::uuid[])) x order by x.incurred_on, x.id`, [clinicId, ids]);
  return r.rows.map(toBill);
}

/**
 * The open bills, supplier by supplier, the most owed first. A supplier typed
 * two ways is one supplier, named as it was typed last, tidied.
 */
export function bySupplier(bills: Bill[]): SupplierOwed[] {
  const groups = new Map<string, SupplierOwed>();
  for (const b of bills) {
    const key = supplierKey(b);
    const g = groups.get(key) ?? { key, name: "", owed: 0, bills: [] };
    g.bills.push(b);
    g.owed = round2(g.owed + b.owed);
    // Oldest first, so the last one seen is the newest.
    g.name = b.vendor.trim().replace(/\s+/g, " ") || g.name;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.owed - a.owed);
}

/**
 * What the clinic owes its outside labs for work not yet paid for (0082) — the
 * same debt, kept on the Lab work page, counted here so the total is everything
 * owed. A dental clinic's only; zero elsewhere.
 */
export async function labsOwed(c: PoolClient, clinicId: string): Promise<{ owed: number; labs: number }> {
  const r = await c.query(
    `select coalesce(sum(lc.cost), 0) as owed, count(distinct lc.lab_id)::int as labs
       from lab_cases lc join dental_labs l on l.id = lc.lab_id
      where lc.clinic_id = $1 and lc.status <> 'cancelled' and lc.expense_id is null and not l.in_house and lc.cost > 0`,
    [clinicId]
  );
  return { owed: Number(r.rows[0].owed), labs: Number(r.rows[0].labs) };
}

/**
 * A payment toward some bills, split oldest first: each bill takes what it
 * still owes until the money runs out. Returns the share each bill gets, which
 * is one expense each — a supplier paid 1,000 against three deliveries is three
 * lines in Expenses, each saying which delivery it paid for.
 */
export function allocate(bills: Bill[], amount: number): { bill: Bill; amount: number }[] {
  let left = round2(amount);
  const out: { bill: Bill; amount: number }[] = [];
  for (const b of bills) {
    if (left <= SETTLED) break;
    if (b.owed <= SETTLED) continue;
    const take = round2(Math.min(left, b.owed));
    out.push({ bill: b, amount: take });
    left = round2(left - take);
  }
  return out;
}
