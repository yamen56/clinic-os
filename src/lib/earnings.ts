import type { PoolClient } from "pg";

/**
 * What a doctor earns of what the clinic collects.
 *
 * One definition, in one place, for the same reason `computeInvoice` is one
 * function used by both the editor's preview and the server that bills: three
 * queries that happen to agree today will not agree next year. Everything below
 * is built from `LEDGER_SQL`, and nothing re-derives the arithmetic.
 *
 * Three rules decide every number here.
 *
 * **A doctor earns as the patient pays.** Not when the invoice is raised. This
 * matches what this product has always meant by revenue — every tile on the
 * dashboard and the invoices list sums `payments.amount`, never `invoices.total`
 * — so "what the clinic kept" is a subtraction between two figures on one basis.
 * It also means the clinic never owes a payout on money it has not collected.
 *
 * **A doctor earns on the ex-tax net.** Sales tax is the state's, not the
 * clinic's to split, so the base is `amount - discount_amount` per line and
 * never includes `tax_amount`. At 16% that means a patient handing over 100
 * earns a doctor on 10% exactly 8.62, which is correct and surprising enough
 * that every screen showing it says *excluding tax*.
 *
 * **The rate is the one frozen on the line**, not the member's rate today.
 * `invoice_line_doctors.commission_percent` was copied from the member when the
 * work was billed; raising somebody's rate in March must not rewrite January.
 */

/**
 * Allocating a payment across an invoice's lines is where this gets subtle.
 *
 * The obvious way — round each payment's share independently and add them up —
 * drifts, because every instalment rounds on its own and the errors do not
 * cancel. A doctor on 17.5% of a 15.00 line, on an invoice settled in
 * twenty-three instalments, comes out at 2.53 against a true 2.63. A payout
 * report that does not foot is one an accountant sends back.
 *
 * So each payment earns the **difference between two rounded cumulative
 * entitlements**: what the doctor is owed once this payment has landed, minus
 * what they were owed before it. The sum telescopes, so the total is always
 * `round(base * rate/100 * collected/total, 2)` — and since `recordPaymentAction`
 * refuses any payment beyond the balance, a settled invoice has
 * `collected = total`, the ratio is exactly 1, and the doctor's share is exactly
 * `round(base * rate/100, 2)`. No true-up branch, no reconciliation job.
 *
 * Four things here are load-bearing:
 *
 *   - The window runs over **every** payment on the invoice and the date range
 *     is applied afterwards. Filtering first would start the running total in
 *     the middle of an invoice and pay the doctor for money already counted.
 *   - `order by paid_at, id`. `paid_at` is caller-supplied, so ties are
 *     reachable; without the tiebreak a given payment's share would move
 *     between page loads.
 *   - Multiply before dividing. Dividing first rounds the ratio away and loses
 *     the exactness at settlement.
 *   - `numeric` throughout. The dashboard casts to `float8` in places; copying
 *     that here would make rounding irreproducible. Cast at the JS edge only.
 *
 * `credit_note_of is null` is belt and braces: a credit note carries no payment
 * rows at all, so it cannot reach this query — but a predicate is checkable and
 * an absent join is not.
 */
const LEDGER_SQL = `
  with touched as (
    select distinct p.invoice_id
      from payments p
     where p.clinic_id = $1 and p.paid_at >= $2 and p.paid_at < $3
  ),
  ledger as (
    select p.id as payment_id, p.invoice_id, p.paid_at, p.amount,
           sum(p.amount) over w            as cum,
           sum(p.amount) over w - p.amount as prev
      from payments p
      join touched t on t.invoice_id = p.invoice_id
     where p.clinic_id = $1
    window w as (partition by p.invoice_id
                 order by p.paid_at, p.id
                 rows between unbounded preceding and current row)
  )
  select l.payment_id,
         l.paid_at,
         l.invoice_id,
         i.number       as invoice_number,
         i.status       as invoice_status,
         i.currency,
         d.doctor_member_id,
         d.commission_percent,
         (ii.amount - ii.discount_amount)                                    as line_net,
         round((ii.amount - ii.discount_amount) * l.cum  / i.total, 2)
           - round((ii.amount - ii.discount_amount) * l.prev / i.total, 2)   as produced,
         round((ii.amount - ii.discount_amount) * d.commission_percent / 100 * l.cum  / i.total, 2)
           - round((ii.amount - ii.discount_amount) * d.commission_percent / 100 * l.prev / i.total, 2)
                                                                             as earned
    from ledger l
    join invoices i             on i.id = l.invoice_id
    join invoice_items ii       on ii.invoice_id = i.id
    join invoice_line_doctors d on d.invoice_item_id = ii.id
   where l.paid_at >= $2 and l.paid_at < $3
     and i.total > 0
     and i.credit_note_of is null
`;

export type EarningsScope = {
  clinicId: string;
  from: Date;
  to: Date;
  /**
   * Voided invoices.
   *
   * A void does not delete the payments behind it and this product has no
   * refunds, so the cash is still in the clinic's drawer. Taking the doctor's
   * share back off them for money nobody returned is the worse error, so *what
   * a doctor is owed* counts it and the payout report flags those invoices for
   * the owner to settle by hand.
   *
   * The clinic's own "after commission" tile passes `false`, because the gross
   * it subtracts from excludes voided invoices too — both sides of a
   * subtraction have to be on one basis or the difference means nothing.
   */
  includeVoided: boolean;
};

function scopeSql(scope: EarningsScope): { sql: string; params: unknown[] } {
  const sql = scope.includeVoided ? LEDGER_SQL : `${LEDGER_SQL} and i.status <> 'void'`;
  return { sql, params: [scope.clinicId, scope.from, scope.to] };
}

export type DoctorEarnings = {
  doctorMemberId: string;
  /** Collected against this doctor's lines, ex-tax. What they brought in. */
  produced: number;
  /** Their share of it, at the rate frozen on each line. */
  earned: number;
};

/** One doctor's own figures. Never returns anybody else's. */
export async function earningsForDoctor(
  c: PoolClient,
  scope: EarningsScope,
  doctorMemberId: string
): Promise<DoctorEarnings> {
  const { sql, params } = scopeSql(scope);
  const r = await c.query(
    `select coalesce(sum(produced), 0) as produced, coalesce(sum(earned), 0) as earned
       from (${sql} and d.doctor_member_id = $4) e`,
    [...params, doctorMemberId]
  );
  const row = r.rows[0];
  return {
    doctorMemberId,
    produced: Number(row.produced),
    earned: Number(row.earned),
  };
}

export type EarningsLine = {
  invoiceId: string;
  number: string;
  status: string;
  currency: string;
  paidAt: string;
  produced: number;
  earned: number;
};

/**
 * Where a doctor's figure came from, invoice by invoice.
 *
 * A total nobody can take apart is a total nobody believes, and this is the
 * screen where somebody is being told what they are owed. Grouped per invoice
 * rather than per payment: which instalment of a part-paid invoice earned which
 * fils is true but not what anybody is asking.
 */
export async function earningsDetailForDoctor(
  c: PoolClient,
  scope: EarningsScope,
  doctorMemberId: string
): Promise<EarningsLine[]> {
  const { sql, params } = scopeSql(scope);
  const r = await c.query(
    `select invoice_id, invoice_number, invoice_status, currency,
            max(paid_at) as paid_at,
            coalesce(sum(produced), 0) as produced,
            coalesce(sum(earned), 0)   as earned
       from (${sql} and d.doctor_member_id = $4) e
      group by invoice_id, invoice_number, invoice_status, currency
      order by max(paid_at) desc
      limit 500`,
    [...params, doctorMemberId]
  );
  return r.rows.map((row) => ({
    invoiceId: row.invoice_id as string,
    number: row.invoice_number as string,
    status: row.invoice_status as string,
    currency: row.currency as string,
    paidAt: (row.paid_at as Date).toISOString(),
    produced: Number(row.produced),
    earned: Number(row.earned),
  }));
}

/** Every doctor's figures — the owner's payout report. Gated on invoices.analytics. */
export async function earningsByDoctor(
  c: PoolClient,
  scope: EarningsScope
): Promise<DoctorEarnings[]> {
  const { sql, params } = scopeSql(scope);
  const r = await c.query(
    `select doctor_member_id,
            coalesce(sum(produced), 0) as produced,
            coalesce(sum(earned), 0)   as earned
       from (${sql}) e
      group by doctor_member_id
      order by earned desc`,
    params
  );
  return r.rows.map((row) => ({
    doctorMemberId: row.doctor_member_id as string,
    produced: Number(row.produced),
    earned: Number(row.earned),
  }));
}

/**
 * The invoices a payout conversation has to start with: voided, and yet paid.
 *
 * Rare — voiding a settled invoice implies a refund, which this product does
 * not do — and precisely because it is rare it is the row nobody notices. The
 * doctor has been credited for money the clinic may or may not have given back,
 * and only a human can say which.
 */
export async function voidedButPaid(
  c: PoolClient,
  scope: EarningsScope
): Promise<{ invoiceId: string; number: string; doctorMemberId: string; earned: number }[]> {
  const r = await c.query(
    `select invoice_id, invoice_number, doctor_member_id,
            coalesce(sum(earned), 0) as earned
       from (${LEDGER_SQL} and i.status = 'void') e
      group by invoice_id, invoice_number, doctor_member_id
     having coalesce(sum(earned), 0) <> 0
      order by earned desc`,
    [scope.clinicId, scope.from, scope.to]
  );
  return r.rows.map((row) => ({
    invoiceId: row.invoice_id as string,
    number: row.invoice_number as string,
    doctorMemberId: row.doctor_member_id as string,
    earned: Number(row.earned),
  }));
}

/**
 * What the clinic collected, and what is left after the doctors' shares.
 *
 * `gross` is the same figure the revenue tiles have always shown — the sum of
 * payments — and both sides here exclude voided invoices so the subtraction is
 * between two numbers measured the same way.
 *
 * The commission is aggregated **per payment before joining back**, which is
 * the whole reason this is not one query: joining `invoice_items` multiplies
 * each payment row by its line count, and summing `p.amount` after that join
 * overstates gross by a factor of however many lines the invoice had.
 *
 * `afterCommission` is not "net revenue" and is never labelled as such — gross
 * is tax-inclusive and commission is computed ex-tax, so the difference is
 * "what the clinic kept of what it collected, before tax and costs".
 */
export async function clinicNetRevenue(
  c: PoolClient,
  scope: Omit<EarningsScope, "includeVoided">
): Promise<{ gross: number; commission: number; afterCommission: number }> {
  const params = [scope.clinicId, scope.from, scope.to];
  const r = await c.query(
    `with earned as (
       select payment_id, sum(earned) as earned
         from (${LEDGER_SQL} and i.status <> 'void') e
        group by payment_id
     )
     select coalesce(sum(p.amount), 0)   as gross,
            coalesce(sum(e.earned), 0)   as commission
       from payments p
       join invoices i on i.id = p.invoice_id and i.status <> 'void'
       left join earned e on e.payment_id = p.id
      where p.clinic_id = $1 and p.paid_at >= $2 and p.paid_at < $3`,
    params
  );
  const gross = Number(r.rows[0].gross);
  const commission = Number(r.rows[0].commission);
  return { gross, commission, afterCommission: round2(gross - commission) };
}

/** Does this clinic split revenue with anybody? Decides whether any of it renders. */
export async function clinicHasCommission(c: PoolClient, clinicId: string): Promise<boolean> {
  const r = await c.query(
    `select 1 from clinic_members
      where clinic_id = $1 and commission_percent is not null limit 1`,
    [clinicId]
  );
  return (r.rowCount ?? 0) > 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
