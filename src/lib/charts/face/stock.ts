/**
 * The face chart's products and stock (0085), on the server.
 *
 * On hand is never stored: it is the sum of the moves, per batch and per
 * product, so a number on the screen can always be taken apart. A treatment
 * takes its units from the batch that expires first; with nothing on hand it
 * still records — the product was already injected — as a move with no batch
 * at the product's last cost, which the Stock page shows as used without stock.
 */

import type { PoolClient } from "pg";
import type { ProductUnit } from "./catalog";

export type { ProductUnit };
export const PRODUCT_UNITS: ProductUnit[] = ["u", "ml", "syringe", "vial", "thread", "piece"];

/** How soon an expiry is worth saying. */
export const EXPIRY_WARN_DAYS = 60;

export type StockBatch = {
  id: string;
  lot: string;
  expiresOn: string | null;
  receivedOn: string;
  qty: number;
  onHand: number;
  unitCost: number;
  expenseId: string | null;
  note: string;
  /** Past its date, by the clinic's clock. Still on hand, but the last thing a treatment takes. */
  expired: boolean;
  /** Nothing has happened to it since it came in, which is what lets it be deleted. */
  untouched: boolean;
};

export type StockProduct = {
  id: string;
  name: string;
  companyId: string | null;
  company: string | null;
  treatments: string[];
  unit: ProductUnit;
  packSize: number;
  lowStock: number | null;
  /** What one unit cost: the last delivery's, or typed before there was one. */
  lastCost: number | null;
  active: boolean;
  /** Everything received, less everything used, returned and adjusted. Below zero: used without stock. */
  onHand: number;
  /** What a treatment can still take: on hand, less whatever sits in an expired batch. */
  usable: number;
  /** On hand but past its date. */
  expired: number;
  /** Stock has moved at least once, so "none left" means it ran out rather than never came. */
  everStocked: boolean;
  /** The batch the next treatment takes from: the one that expires first, with units left. */
  next: { lot: string; expiresOn: string | null } | null;
  batches: StockBatch[];
};

export type Company = {
  id: string;
  name: string;
  phone: string;
  note: string;
  active: boolean;
  /** How many of the clinic's products come from it, archived ones included. */
  products: number;
  /** What every delivery from it cost, at the price each came in at. */
  spent: number;
};

const day = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);

/** Today by the clinic's clock, as SQL. A batch that expires today is still good today. */
const clinicToday = (clinic: string) => `(now() at time zone (select timezone from clinics where id = ${clinic}))::date`;

/** Units a treatment can still take, for the product aliased `p`. The no-batch line counts: it is what is owed. */
export const usableSql = (p: string, clinic: string) =>
  `coalesce((select sum(m.qty) from stock_moves m left join stock_batches b on b.id = m.batch_id
     where m.product_id = ${p}.id and (b.expires_on is null or b.expires_on >= ${clinicToday(clinic)})), 0)`;

/**
 * "Running low", once.
 *
 * The nav badge and the page's chips used to answer this separately and disagree:
 * the badge wanted a warning level set, the chip also counted anything at zero.
 * A product in use counts when what it can still give is at or below its warning
 * level, which with no level set means run out. One that has never had stock is
 * not counted: it has not run out of anything, and a clinic listing its products
 * should not be told so ten times.
 */
export const needsRestockSql = (p: string, clinic: string) =>
  `${p}.active and exists (select 1 from stock_moves m where m.product_id = ${p}.id)
     and ${usableSql(p, clinic)} <= coalesce(${p}.low_stock, 0)`;

/** The same rule, for a product already loaded. */
export const needsRestock = (p: StockProduct) => p.active && p.everStocked && p.usable <= (p.lowStock ?? 0);

/**
 * The clinic's products with what is on hand, batch by batch, in one statement.
 * Dates come back as text: a `date` read through node-pg is a JS Date in the
 * server's zone, which moves it a day west of the clinic.
 */
export async function loadStockProducts(c: PoolClient, clinicId: string, opts: { activeOnly?: boolean; withBatches?: boolean } = {}): Promise<StockProduct[]> {
  const r = await c.query(
    `select p.id, p.name, p.company_id, co.name as company, p.treatments, p.unit, p.pack_size, p.low_stock, p.last_cost, p.active,
            coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id), 0)::float as on_hand,
            ${usableSql("p", "$1")}::float as usable,
            exists (select 1 from stock_moves m where m.product_id = p.id) as ever_stocked,
            (select coalesce(json_agg(b order by b.expires_on nulls last, b.received_on, b.created_at), '[]'::json)
               from (select sb.id, sb.lot, sb.expires_on::text as expires_on, sb.received_on::text as received_on, sb.qty::float as qty,
                            sb.unit_cost::float as unit_cost, sb.expense_id, sb.note, sb.created_at,
                            coalesce(sb.expires_on < ${clinicToday("$1")}, false) as expired,
                            not exists (select 1 from stock_moves m where m.batch_id = sb.id and m.kind <> 'receive') as untouched,
                            coalesce((select sum(m.qty) from stock_moves m where m.batch_id = sb.id), 0)::float as on_hand
                       from stock_batches sb where sb.product_id = p.id) b
              where $3::boolean or b.on_hand > 0) as batches
       from aesthetic_products p
       left join aesthetic_companies co on co.id = p.company_id
      where p.clinic_id = $1 and ($2::boolean is false or p.active)
      order by p.sort, p.name`,
    [clinicId, !!opts.activeOnly, !!opts.withBatches]
  );
  return r.rows.map((x) => {
    const batches = (x.batches as Record<string, unknown>[]).map((b) => ({
      id: b.id as string,
      lot: (b.lot as string) ?? "",
      expiresOn: day(b.expires_on),
      receivedOn: day(b.received_on)!,
      qty: Number(b.qty),
      onHand: Number(b.on_hand),
      unitCost: Number(b.unit_cost),
      expenseId: (b.expense_id as string) ?? null,
      note: (b.note as string) ?? "",
      expired: !!b.expired,
      untouched: !!b.untouched,
    }));
    const next = batches.find((b) => b.onHand > 0 && !b.expired) ?? null;
    return {
      id: x.id,
      name: x.name,
      companyId: x.company_id ?? null,
      company: x.company ?? null,
      treatments: x.treatments ?? [],
      unit: x.unit,
      packSize: Number(x.pack_size),
      lowStock: x.low_stock == null ? null : Number(x.low_stock),
      lastCost: x.last_cost == null ? null : Number(x.last_cost),
      active: !!x.active,
      onHand: Number(x.on_hand),
      usable: Number(x.usable),
      expired: Math.max(0, Math.round((Number(x.on_hand) - Number(x.usable)) * 100) / 100),
      everStocked: !!x.ever_stocked,
      next: next ? { lot: next.lot, expiresOn: next.expiresOn } : null,
      batches,
    };
  });
}

/**
 * A product as somebody without Stock may see it.
 *
 * The chart needs a product's name and what is left of it, and anybody who can
 * open a patient opens the chart. What a clinic pays for its Botox is not theirs
 * to read, and leaving it out of the screen does not keep it out of the page.
 */
export function withoutCosts(p: StockProduct): StockProduct {
  return { ...p, lastCost: null, batches: p.batches.map((b) => ({ ...b, unitCost: 0, expenseId: null, note: "" })) };
}

export async function loadCompanies(c: PoolClient, clinicId: string): Promise<Company[]> {
  const r = await c.query(
    `select co.id, co.name, co.phone, co.note, co.active,
            (select count(*)::int from aesthetic_products p where p.company_id = co.id) as products,
            coalesce((select sum(b.qty * b.unit_cost) from stock_batches b join aesthetic_products p on p.id = b.product_id
                       where p.company_id = co.id), 0)::float as spent
       from aesthetic_companies co where co.clinic_id = $1 order by co.sort, co.name`,
    [clinicId]
  );
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    phone: x.phone,
    note: x.note,
    active: !!x.active,
    products: Number(x.products),
    spent: Math.round(Number(x.spent) * 100) / 100,
  }));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A treatment takes `qty` units of a product: from the batch that expires
 * first, then the next; whatever is not on hand is taken at the product's last
 * cost with no batch. The cost is frozen on the treatment (chart_mark_products).
 *
 * Expired batches come last, not never. Sorting by date alone made the oldest
 * expired vial the first thing every treatment took. The doctor is warned on the
 * chart, but what they say was used is recorded, because it was: a product that
 * has gone into a patient is a fact the record has to hold, however it got there.
 *
 * The product row is locked first, so two treatments saved at once never take
 * the same last units.
 */
export async function takeStock(c: PoolClient, clinicId: string, productId: string, qty: number, markId: string, by: string): Promise<{ cost: number }> {
  const p = (await c.query(`select last_cost from aesthetic_products where id = $1 and clinic_id = $2 for update`, [productId, clinicId])).rows[0];
  const batches = (
    await c.query(
      `select b.id, b.unit_cost::float as unit_cost,
              coalesce((select sum(m.qty) from stock_moves m where m.batch_id = b.id), 0)::float as on_hand
         from stock_batches b
        where b.product_id = $1 and b.clinic_id = $2
        order by coalesce(b.expires_on < ${clinicToday("$2")}, false), b.expires_on nulls last, b.received_on, b.created_at`,
      [productId, clinicId]
    )
  ).rows as { id: string; unit_cost: number; on_hand: number }[];
  let left = qty;
  let cost = 0;
  for (const b of batches) {
    if (left <= 0) break;
    if (b.on_hand <= 0) continue;
    const take = Math.min(left, b.on_hand);
    await c.query(
      `insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, mark_id, by_user) values ($1, $2, $3, 'use', $4, $5, $6, $7)`,
      [clinicId, productId, b.id, -take, b.unit_cost, markId, by]
    );
    cost += take * b.unit_cost;
    left = round2(left - take);
  }
  if (left > 0) {
    const unit = p?.last_cost == null ? 0 : Number(p.last_cost);
    await c.query(
      `insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, mark_id, by_user) values ($1, $2, null, 'use', $3, $4, $5, $6)`,
      [clinicId, productId, -left, unit, markId, by]
    );
    cost += left * unit;
  }
  cost = round2(cost);
  await c.query(`insert into chart_mark_products (clinic_id, mark_id, product_id, qty, cost) values ($1, $2, $3, $4, $5)`, [clinicId, markId, productId, qty, cost]);
  return { cost };
}

/**
 * Units left stranded on the no-batch line go to the deliveries that settled it.
 *
 * A treatment recorded with nothing on hand overdraws that line, and the next
 * delivery settles it out of its own batch. Voiding the treatment afterwards puts
 * the units back on the line, where no treatment can reach them, and leaves the
 * delivery short by as much. See 0092, which repaired what had already happened.
 */
async function settleStranded(c: PoolClient, clinicId: string, productId: string, by: string): Promise<void> {
  let owing = Number((await c.query(`select coalesce(sum(qty), 0) as n from stock_moves where product_id = $1 and batch_id is null`, [productId])).rows[0].n);
  if (owing <= 0) return;
  const settled = (
    await c.query(
      `select batch_id, -sum(qty)::float as amount, max(unit_cost)::float as unit_cost
         from stock_moves
        where product_id = $1 and batch_id is not null and kind = 'adjust'
          and reason in ('used before it was received', 'voided after it was settled')
        group by batch_id
        order by max(at) desc`,
      [productId]
    )
  ).rows as { batch_id: string; amount: number; unit_cost: number }[];
  for (const s of settled) {
    if (owing <= 0) break;
    const take = Math.min(owing, s.amount);
    if (take <= 0) continue;
    await c.query(
      `insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, by_user, reason)
       values ($1, $2, $3, 'adjust', $4, $5, $6, 'voided after it was settled'), ($1, $2, null, 'adjust', $7, 0, $6, 'voided after it was settled')`,
      [clinicId, productId, s.batch_id, take, s.unit_cost, by, -take]
    );
    owing = round2(owing - take);
  }
}

/** A voided treatment's units go back where they came from: each batch, and the no-batch line it overdrew. */
export async function returnStock(c: PoolClient, clinicId: string, markId: string, by: string): Promise<void> {
  await c.query(
    `insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, mark_id, by_user, reason)
     select $1, product_id, batch_id, 'return', -sum(qty), max(unit_cost), $2, $3, 'voided'
       from stock_moves where mark_id = $2 and clinic_id = $1
      group by product_id, batch_id
     having sum(qty) < 0`,
    [clinicId, markId, by]
  );
  const touched = (await c.query(`select distinct product_id from stock_moves where mark_id = $1 and clinic_id = $2`, [markId, clinicId])).rows;
  for (const t of touched) await settleStranded(c, clinicId, t.product_id, by);
}

/** A mis-tap undone: as if it never happened, so its moves go with it. */
export async function dropStock(c: PoolClient, clinicId: string, markId: string): Promise<void> {
  await c.query(`delete from stock_moves where mark_id = $1 and clinic_id = $2`, [markId, clinicId]);
}

/** One line of a product's history. The patient is there only for somebody who may open patients. */
export type StockMove = {
  id: string;
  kind: "receive" | "use" | "return" | "adjust";
  qty: number;
  at: string;
  lot: string | null;
  reason: string;
  by: string | null;
  patient: { id: string; name: string } | null;
  treatment: string | null;
};

/** Everything that happened to a product, newest first: the numbers on the Stock page, taken apart. */
export async function loadProductMoves(c: PoolClient, clinicId: string, productId: string, withPatients: boolean): Promise<StockMove[]> {
  const r = await c.query(
    `select m.id, m.kind, m.qty::float as qty, m.at, m.reason, b.lot, u.full_name as by_name,
            cm.patient_id, p.full_name as patient, cm.label
       from stock_moves m
       left join stock_batches b on b.id = m.batch_id
       left join users u on u.id = m.by_user
       left join chart_marks cm on cm.id = m.mark_id
       left join patients p on p.id = cm.patient_id
      where m.clinic_id = $1 and m.product_id = $2
      order by m.at desc, m.id
      limit 200`,
    [clinicId, productId]
  );
  return r.rows.map((x) => ({
    id: x.id,
    kind: x.kind,
    qty: Number(x.qty),
    at: new Date(x.at).toISOString(),
    lot: x.lot ?? null,
    reason: x.reason ?? "",
    by: x.by_name ?? null,
    patient: withPatients && x.patient_id ? { id: x.patient_id, name: x.patient ?? "" } : null,
    treatment: x.label ?? null,
  }));
}

/** What each of these treatments used, for the chart. Costs only for a member who sees stock. */
export type MarkProduct = {
  markId: string;
  productId: string;
  name: string;
  company: string | null;
  unit: ProductUnit;
  qty: number;
  cost: number | null;
  /** The lots it came out of, so a recall can be traced to the patient. */
  lots: string[];
};

export async function loadMarkProducts(c: PoolClient, clinicId: string, patientId: string, withCost: boolean): Promise<MarkProduct[]> {
  const r = await c.query(
    `select cmp.mark_id, cmp.product_id, p.name, co.name as company, p.unit, cmp.qty::float as qty, cmp.cost::float as cost,
            coalesce((select array_agg(distinct b.lot order by b.lot) from stock_moves m join stock_batches b on b.id = m.batch_id
                       where m.mark_id = cmp.mark_id and m.product_id = cmp.product_id and m.kind = 'use' and b.lot <> ''), '{}') as lots
       from chart_mark_products cmp
       join chart_marks m on m.id = cmp.mark_id
       join aesthetic_products p on p.id = cmp.product_id
       left join aesthetic_companies co on co.id = p.company_id
      where cmp.clinic_id = $1 and m.patient_id = $2
      order by cmp.created_at`,
    [clinicId, patientId]
  );
  return r.rows.map((x) => ({
    markId: x.mark_id,
    productId: x.product_id,
    name: x.name,
    company: x.company ?? null,
    unit: x.unit,
    qty: Number(x.qty),
    cost: withCost ? Number(x.cost) : null,
    lots: (x.lots as string[]) ?? [],
  }));
}

/**
 * Something on the shelf that needs a person: running low, run out, about to
 * expire, or expired and still there.
 *
 * `episode` names this occurrence, so it is told once. Running low is keyed by
 * the latest delivery: it is news again only after stock has come in and run
 * down again, not every morning it stays low.
 */
export type StockAttention = {
  kind: "low" | "out" | "expiring" | "expired";
  productId: string;
  name: string;
  unit: ProductUnit;
  /** What is left: usable for low and out, in the batch for the rest. */
  amount: number;
  lot: string | null;
  expiresOn: string | null;
  episode: string;
};

export async function loadStockAttention(c: PoolClient, clinicId: string): Promise<StockAttention[]> {
  const low = (
    await c.query(
      `select p.id, p.name, p.unit, ${usableSql("p", "$1")}::float as usable,
              (select b.id from stock_batches b where b.product_id = p.id order by b.created_at desc limit 1) as last_batch
         from aesthetic_products p
        where p.clinic_id = $1 and ${needsRestockSql("p", "$1")}
        order by p.sort, p.name`,
      [clinicId]
    )
  ).rows;
  const dated = (
    await c.query(
      `select * from (
         select b.id, b.lot, b.expires_on::text as expires_on, p.id as product_id, p.name, p.unit,
                b.expires_on < ${clinicToday("$1")} as expired,
                coalesce((select sum(m.qty) from stock_moves m where m.batch_id = b.id), 0)::float as on_hand
           from stock_batches b join aesthetic_products p on p.id = b.product_id
          where b.clinic_id = $1 and p.active and b.expires_on is not null
            and b.expires_on <= ${clinicToday("$1")} + ${EXPIRY_WARN_DAYS}) x
        where x.on_hand > 0
        order by x.expires_on`,
      [clinicId]
    )
  ).rows;
  return [
    ...low.map((p) => {
      const kind = Number(p.usable) <= 0 ? ("out" as const) : ("low" as const);
      return {
        kind,
        productId: p.id as string,
        name: p.name as string,
        unit: p.unit as ProductUnit,
        amount: Math.max(0, Number(p.usable)),
        lot: null,
        expiresOn: null,
        episode: `stock:${kind}:${p.id}:${p.last_batch ?? "none"}`,
      };
    }),
    ...dated.map((b) => {
      const kind = b.expired ? ("expired" as const) : ("expiring" as const);
      return {
        kind,
        productId: b.product_id as string,
        name: b.name as string,
        unit: b.unit as ProductUnit,
        amount: Number(b.on_hand),
        lot: (b.lot as string) || null,
        expiresOn: b.expires_on as string,
        episode: `stock:${kind}:${b.id}`,
      };
    }),
  ];
}
