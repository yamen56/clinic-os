import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { clinicNetRevenue } from "./earnings";
import { clinicExpenses, expensesByCategory, type ExpenseCategoryTotal } from "./expenses";
import { labsOwed, openBills } from "./bills";
import { owedSql, round2 } from "./invoices";
import { parsePeriodParam, type Bucket } from "./finance-periods";

/**
 * The clinic's money over a period, for the Analytics tab of Finance.
 *
 * Every figure here is clinic-wide, so nothing in this file is safe to call
 * for a member who may not see the takings: the page checks
 * `invoices.analytics` (and that the member's list is not filtered to their
 * own work) before it asks for any of it, and the two halves that answer to
 * other grants — what was spent, and the doctors' shares — are asked for only
 * when `opts` says so. A query that does not run cannot leak.
 *
 * Measured the way the rest of the product measures, so a number here is the
 * number the other screens show for the same days:
 *
 *   collected   payments by `paid_at`, a cancelled invoice's left out
 *   invoiced    invoices by `created_at`, cancelled ones and credit notes left out
 *   spent       expenses by `spent_on`, a calendar date — see lib/expenses
 *
 * One connection, one statement at a time: node-pg serialises a client, so
 * these are written in sequence rather than dressed up as parallel.
 */

export type Period = {
  /** The URL's own words for it: `month`, `year`, `all`, `2026-10` or `2025`. */
  key: string;
  kind: "month" | "year" | "all";
  /** Half-open, in the clinic's own time: [from, to). */
  from: DateTime;
  to: DateTime;
  /**
   * The same stretch one step earlier, to measure against. Empty — equal to
   * `from` — for all time, which has no "before", so every comparison in it
   * comes out as nothing to compare.
   */
  prevFrom: DateTime;
  prevTo: DateTime;
  compare: boolean;
  bucket: Bucket;
};

/**
 * The days a period covers, and the days it is compared with.
 *
 * A period still running ends at the end of today, and is compared with the
 * same number of days one step back — the 1st to the 15th against the 1st to
 * the 15th — because half a month beside a whole one always looks like a
 * collapse. A month or year already over is compared whole with the one before
 * it. All time runs from the month of the clinic's first record (`since`) and
 * is compared with nothing, by month — or by year, past three years of them.
 */
export function periodOf(tz: string, key: string, since: Date | null): Period {
  const now = DateTime.now().setZone(tz);
  const tomorrow = now.startOf("day").plus({ days: 1 });
  const upTo = (end: DateTime) => (end > tomorrow ? tomorrow : end);
  const one = (kind: "month" | "year", from: DateTime, bucket: Bucket): Period => {
    const step = kind === "month" ? { months: 1 } : { years: 1 };
    const to = upTo(from.plus(step));
    return { key, kind, from, to, prevFrom: from.minus(step), prevTo: to.minus(step), compare: true, bucket };
  };

  if (key === "all") {
    const first = since ? DateTime.fromJSDate(since).setZone(tz).startOf("month") : now.startOf("month");
    const from = first < tomorrow ? first : now.startOf("month");
    const months = Math.ceil(tomorrow.diff(from, "months").months);
    const bucket: Bucket = months > 36 ? "year" : "month";
    return { key, kind: "all", from: bucket === "year" ? from.startOf("year") : from, to: tomorrow, prevFrom: from, prevTo: from, compare: false, bucket };
  }
  if (key === "year") return one("year", now.startOf("year"), "month");
  const picked = parsePeriodParam(key);
  if (picked) {
    const start = DateTime.fromObject({ year: picked.year, month: picked.month ?? 1, day: 1 }, { zone: tz });
    // A month or year that has not begun is this one, not an empty page.
    if (start.isValid && start < tomorrow) {
      return picked.month ? one("month", start, "day") : one("year", start, "month");
    }
  }
  return { ...one("month", now.startOf("month"), "day"), key: "month" };
}

/**
 * When the clinic's money starts: its first payment, invoice or expense.
 * All time runs from here, and the month menu reaches back to it.
 */
export async function firstMoneyDate(c: PoolClient, clinicId: string): Promise<Date | null> {
  const r = await c.query(
    `select least(
       (select min(paid_at) from payments where clinic_id = $1),
       (select min(created_at) from invoices where clinic_id = $1),
       (select min(spent_on)::timestamptz from expenses where clinic_id = $1)
     ) as first`,
    [clinicId]
  );
  return (r.rows[0]?.first as Date | null) ?? null;
}

/** Every bucket of the period, in order — so a quiet day is a zero and not a gap. */
export function bucketsOf(p: Period): string[] {
  const out: string[] = [];
  let d = p.from.startOf(p.bucket);
  while (d < p.to) {
    out.push(d.toISODate()!);
    d = d.plus(p.bucket === "day" ? { days: 1 } : p.bucket === "month" ? { months: 1 } : { years: 1 });
  }
  return out;
}

export type SeriesPoint = { bucket: string; amount: number };

export type FinanceAnalytics = {
  collected: number;
  collectedPrev: number;
  payments: number;
  payers: number;
  invoiced: number;
  invoicedPrev: number;
  invoices: number;
  /** Of what was invoiced in the period, how much has been paid by now. */
  invoicedPaid: number;
  series: SeriesPoint[];
  methods: { method: string; amount: number; n: number }[];
  services: { key: string; name: string; nameAr: string | null; amount: number; qty: number }[];
  doctors: { id: string; name: string; amount: number; invoices: number }[];
  owed: {
    total: number;
    invoices: number;
    /** By how long the invoice has waited: up to 30 days, 31–60, 61–90, longer. */
    aging: [number, number, number, number];
    patients: { id: string; name: string; owed: number; invoices: number }[];
  };
  /** Present only for a member who may see what the clinic spends. */
  spend: null | {
    total: number;
    prev: number;
    series: SeriesPoint[];
    categories: ExpenseCategoryTotal[];
    /** Still owed to suppliers and outside labs, as of today. */
    toPay: number;
  };
  /** Sales tax inside what was collected. Asked for only where it is subtracted. */
  tax: number | null;
  /** The doctors' shares of it. Only for whoever holds the clinic. */
  commission: number | null;
};

export async function financeAnalytics(
  c: PoolClient,
  args: { clinicId: string; tz: string; period: Period; dental: boolean },
  opts: { spend: boolean; shares: boolean }
): Promise<FinanceAnalytics> {
  const { clinicId, tz, period } = args;
  const from = period.from.toUTC().toISO()!;
  const to = period.to.toUTC().toISO()!;
  const prevFrom = period.prevFrom.toUTC().toISO()!;
  const prevTo = period.prevTo.toUTC().toISO()!;
  /* A cancelled invoice's payments are not the clinic's money (Yamen, 2026-10-14). */
  const PAID = `from payments p join invoices v on v.id = p.invoice_id and v.status <> 'void' where p.clinic_id = $1`;
  /* What counts as invoiced: not cancelled, and not the credit note that cancels another. */
  const RAISED = `i.clinic_id = $1 and i.status <> 'void' and i.credit_note_of is null`;

  const [paid] = (
    await c.query(
      `select coalesce(sum(p.amount) filter (where p.paid_at >= $2 and p.paid_at < $3), 0)::float8 as collected,
              count(*) filter (where p.paid_at >= $2 and p.paid_at < $3)::int as payments,
              count(distinct p.patient_id) filter (where p.paid_at >= $2 and p.paid_at < $3)::int as payers,
              coalesce(sum(p.amount) filter (where p.paid_at >= $4 and p.paid_at < $5), 0)::float8 as collected_prev
         ${PAID} and p.paid_at >= $4 and p.paid_at < $3`,
      [clinicId, from, to, prevFrom, prevTo]
    )
  ).rows;

  const [raised] = (
    await c.query(
      `select coalesce(sum(i.total) filter (where i.created_at >= $2 and i.created_at < $3), 0)::float8 as invoiced,
              count(*) filter (where i.created_at >= $2 and i.created_at < $3)::int as invoices,
              coalesce(sum(i.amount_paid) filter (where i.created_at >= $2 and i.created_at < $3), 0)::float8 as invoiced_paid,
              coalesce(sum(i.total) filter (where i.created_at >= $4 and i.created_at < $5), 0)::float8 as invoiced_prev
         from invoices i
        where ${RAISED} and i.created_at >= $4 and i.created_at < $3`,
      [clinicId, from, to, prevFrom, prevTo]
    )
  ).rows;

  /* Bucketed by the clinic's own day, so a payment at 01:00 in Amman is not yesterday's. */
  const seriesRows = (
    await c.query(
      `select to_char(date_trunc($4::text, p.paid_at at time zone $5), 'YYYY-MM-DD') as bucket,
              sum(p.amount)::float8 as amount
         ${PAID} and p.paid_at >= $2 and p.paid_at < $3
        group by 1`,
      [clinicId, from, to, period.bucket, tz]
    )
  ).rows as SeriesPoint[];

  const methods = (
    await c.query(
      `select p.method, sum(p.amount)::float8 as amount, count(*)::int as n
         ${PAID} and p.paid_at >= $2 and p.paid_at < $3
        group by p.method
        order by 2 desc`,
      [clinicId, from, to]
    )
  ).rows as FinanceAnalytics["methods"];

  /*
    What earned the most, by what was invoiced. A line typed by hand has no
    service behind it, so it is grouped by what was typed. Both names travel:
    the reader's language is chosen on the page, not collapsed here.
  */
  const services = (
    await c.query(
      `select coalesce(s.id::text, 'x:' || lower(btrim(ii.description))) as key,
              coalesce(s.name, btrim(ii.description)) as name, s.name_ar,
              sum(ii.amount)::float8 as amount, sum(ii.qty)::float8 as qty
         from invoice_items ii
         join invoices i on i.id = ii.invoice_id
         left join services s on s.id = ii.service_id
        where ii.clinic_id = $1 and ${RAISED} and i.created_at >= $2 and i.created_at < $3
        group by 1, 2, 3
       having sum(ii.amount) > 0
        order by 4 desc
        limit 8`,
      [clinicId, from, to]
    )
  ).rows.map((r) => ({
    key: r.key as string,
    name: r.name as string,
    nameAr: (r.name_ar as string) ?? null,
    amount: Number(r.amount),
    qty: Number(r.qty),
  }));

  /* The work invoiced under each doctor's name — what they billed, not what they are paid. */
  const doctors = (
    await c.query(
      `select cm.id, u.full_name as name, sum(ii.amount)::float8 as amount, count(distinct i.id)::int as invoices
         from invoice_line_doctors ild
         join invoice_items ii on ii.id = ild.invoice_item_id
         join invoices i on i.id = ii.invoice_id
         join clinic_members cm on cm.id = ild.doctor_member_id
         join users u on u.id = cm.user_id
        where ild.clinic_id = $1 and ${RAISED} and i.created_at >= $2 and i.created_at < $3
        group by cm.id, u.full_name
       having sum(ii.amount) > 0
        order by 3 desc
        limit 8`,
      [clinicId, from, to]
    )
  ).rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    amount: Number(r.amount),
    invoices: Number(r.invoices),
  }));

  /* What is owed is a fact about today, whatever period is on screen. */
  const [owed] = (
    await c.query(
      `select coalesce(sum(o), 0)::float8 as total, count(*)::int as invoices,
              coalesce(sum(o) filter (where age <= 30), 0)::float8 as a30,
              coalesce(sum(o) filter (where age > 30 and age <= 60), 0)::float8 as a60,
              coalesce(sum(o) filter (where age > 60 and age <= 90), 0)::float8 as a90,
              coalesce(sum(o) filter (where age > 90), 0)::float8 as older
         from (select i.total - i.amount_paid as o,
                      extract(epoch from now() - i.created_at) / 86400 as age
                 from invoices i
                where i.clinic_id = $1 and ${owedSql("i")}) x`,
      [clinicId]
    )
  ).rows;
  const owing = (
    await c.query(
      `select p.id, p.full_name as name, sum(i.total - i.amount_paid)::float8 as owed, count(*)::int as invoices
         from invoices i
         join patients p on p.id = i.patient_id
        where i.clinic_id = $1 and ${owedSql("i")}
        group by p.id, p.full_name
        order by 3 desc
        limit 6`,
      [clinicId]
    )
  ).rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    owed: Number(r.owed),
    invoices: Number(r.invoices),
  }));

  let spend: FinanceAnalytics["spend"] = null;
  if (opts.spend) {
    /* Calendar dates on this side: `spent_on` is a `date`, and an instant would move a day across the border. */
    const dFrom = period.from.toISODate()!;
    const dTo = period.to.toISODate()!;
    const total = await clinicExpenses(c, { clinicId, from: dFrom, to: dTo });
    const prev = await clinicExpenses(c, {
      clinicId,
      from: period.prevFrom.toISODate()!,
      to: period.prevTo.toISODate()!,
    });
    const spendSeries = (
      await c.query(
        `select to_char(date_trunc($4::text, e.spent_on::timestamp), 'YYYY-MM-DD') as bucket,
                sum(e.amount)::float8 as amount
           from expenses e
          where e.clinic_id = $1 and e.spent_on >= $2::date and e.spent_on < $3::date
          group by 1`,
        [clinicId, dFrom, dTo, period.bucket]
      )
    ).rows as SeriesPoint[];
    const categories = await expensesByCategory(c, { clinicId, from: dFrom, to: dTo });
    const bills = await openBills(c, clinicId);
    const labs = args.dental ? (await labsOwed(c, clinicId)).owed : 0;
    spend = {
      total,
      prev,
      series: fill(period, spendSeries),
      categories,
      toPay: round2(bills.reduce((sum, b) => sum + b.owed, 0) + labs),
    };
  }

  /*
    The tax and the doctors' shares inside what was collected, from the one
    place that measures them (lib/earnings). Skipped unless a profit line will
    be drawn from it — it is the heaviest statement on the page.
  */
  let tax: number | null = null;
  let commission: number | null = null;
  if (opts.spend || opts.shares) {
    const net = await clinicNetRevenue(c, { clinicId, from: new Date(from), to: new Date(to) });
    tax = net.tax;
    commission = opts.shares ? net.commission : null;
  }

  return {
    collected: Number(paid.collected),
    collectedPrev: Number(paid.collected_prev),
    payments: Number(paid.payments),
    payers: Number(paid.payers),
    invoiced: Number(raised.invoiced),
    invoicedPrev: Number(raised.invoiced_prev),
    invoices: Number(raised.invoices),
    invoicedPaid: Number(raised.invoiced_paid),
    series: fill(period, seriesRows),
    methods,
    services,
    doctors,
    owed: {
      total: Number(owed.total),
      invoices: Number(owed.invoices),
      aging: [Number(owed.a30), Number(owed.a60), Number(owed.a90), Number(owed.older)],
      patients: owing,
    },
    spend,
    tax,
    commission,
  };
}

function fill(period: Period, rows: SeriesPoint[]): SeriesPoint[] {
  const by = new Map(rows.map((r) => [r.bucket, Number(r.amount)]));
  return bucketsOf(period).map((bucket) => ({ bucket, amount: by.get(bucket) ?? 0 }));
}
