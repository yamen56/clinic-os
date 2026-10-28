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
  /** The batch the next treatment takes from: the one that expires first, with units left. */
  next: { lot: string; expiresOn: string | null } | null;
  batches: StockBatch[];
};

export type Company = { id: string; name: string; phone: string; note: string; active: boolean };

const day = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);

/**
 * The clinic's products with what is on hand, batch by batch, in one statement.
 * Dates come back as text: a `date` read through node-pg is a JS Date in the
 * server's zone, which moves it a day west of the clinic.
 */
export async function loadStockProducts(c: PoolClient, clinicId: string, opts: { activeOnly?: boolean; withBatches?: boolean } = {}): Promise<StockProduct[]> {
  const r = await c.query(
    `select p.id, p.name, p.company_id, co.name as company, p.treatments, p.unit, p.pack_size, p.low_stock, p.last_cost, p.active,
            coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id), 0)::float as on_hand,
            (select coalesce(json_agg(b order by b.expires_on nulls last, b.received_on, b.created_at), '[]'::json)
               from (select sb.id, sb.lot, sb.expires_on::text as expires_on, sb.received_on::text as received_on, sb.qty::float as qty,
                            sb.unit_cost::float as unit_cost, sb.expense_id, sb.note, sb.created_at,
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
    }));
    const next = batches.find((b) => b.onHand > 0) ?? null;
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
      next: next ? { lot: next.lot, expiresOn: next.expiresOn } : null,
      batches,
    };
  });
}

export async function loadCompanies(c: PoolClient, clinicId: string): Promise<Company[]> {
  const r = await c.query(`select id, name, phone, note, active from aesthetic_companies where clinic_id = $1 order by sort, name`, [clinicId]);
  return r.rows.map((x) => ({ id: x.id, name: x.name, phone: x.phone, note: x.note, active: !!x.active }));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A treatment takes `qty` units of a product: from the batch that expires
 * first, then the next; whatever is not on hand is taken at the product's last
 * cost with no batch. The cost is frozen on the treatment (chart_mark_products).
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
        order by b.expires_on nulls last, b.received_on, b.created_at`,
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
}

/** A mis-tap undone: as if it never happened, so its moves go with it. */
export async function dropStock(c: PoolClient, clinicId: string, markId: string): Promise<void> {
  await c.query(`delete from stock_moves where mark_id = $1 and clinic_id = $2`, [markId, clinicId]);
}

/** What each of these treatments used, for the chart. Costs only for a member who sees stock. */
export type MarkProduct = { markId: string; productId: string; name: string; company: string | null; unit: ProductUnit; qty: number; cost: number | null };

export async function loadMarkProducts(c: PoolClient, clinicId: string, patientId: string, withCost: boolean): Promise<MarkProduct[]> {
  const r = await c.query(
    `select cmp.mark_id, cmp.product_id, p.name, co.name as company, p.unit, cmp.qty::float as qty, cmp.cost::float as cost
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
  }));
}
