"use server";

/*
  Products and stock for the face chart (0085): the companies, the products,
  deliveries in and corrections. Every action is `stock` on a clinic with the
  face chart, and answers with the lists as they now stand, so the screen
  shows what was saved without asking again.

  Deleting is one tap and an Undo, not a confirm box (2026-11-02, "a faster
  delete button"). What is undone is read back from the record of doing it, never
  from anything the browser sends, and only by the person who did it, within the
  half hour. Something a treatment or a doctor's share reaches back to cannot
  really be deleted, so it is archived instead and the answer says which happened.
*/

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic, can, type ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { clinicTreatmentKeys, resolveTreatment } from "@/lib/charts/face/treatments";
import {
  PRODUCT_UNITS,
  loadCompanies,
  loadProductMoves,
  loadStockProducts,
  type Company,
  type StockMove,
  type StockProduct,
} from "@/lib/charts/face/stock";
import { isUuid } from "@/lib/uuid";
import type { PoolClient } from "pg";

type Answer = {
  products?: StockProduct[];
  companies?: Company[];
  error?: string;
  /** What a delete did: gone, or kept because something still reaches back to it. */
  outcome?: "deleted" | "archived";
  /** The delivery is gone but its expense stayed, because somebody had changed it. */
  expenseKept?: boolean;
  /** The correction just made, so it can be undone. */
  moveId?: string;
};

async function guard(slug: string): Promise<ClinicAccess | null> {
  const access = await requireClinic(slug);
  if (!can(access, "stock") || !access.clinic.features.aesthetic) return null;
  return access;
}

async function lists(c: PoolClient, clinicId: string): Promise<Answer> {
  return { products: await loadStockProducts(c, clinicId, { withBatches: true }), companies: await loadCompanies(c, clinicId) };
}

/** How long Undo is honoured after the toast has gone. */
const UNDO_WINDOW = "30 minutes";

/** The record of this person deleting this thing, if it is recent enough to take back. */
async function lastDelete(c: PoolClient, access: ClinicAccess, action: string, entityId: string): Promise<Record<string, unknown> | null> {
  const r = await c.query(
    `select detail from audit_log
      where clinic_id = $1 and user_id = $2 and action = $3 and entity_id = $4
        and created_at > now() - interval '${UNDO_WINDOW}'
      order by created_at desc limit 1`,
    [access.clinicId, access.session.user.id, action, entityId]
  );
  return (r.rows[0]?.detail as Record<string, unknown>) ?? null;
}

/** A product's own price on the face chart. The link is a text column, so nothing removes it for us. */
async function setProductPrices(c: PoolClient, clinicId: string, productId: string, active: boolean): Promise<void> {
  await c.query(`update services set active = $3 where clinic_id = $1 and chart_variant = $2`, [clinicId, productId, active]);
}

const companySchema = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).default(""),
  note: z.string().trim().max(500).default(""),
});

export async function saveCompanyAction(slug: string, data: unknown): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  const parsed = companySchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  return inClinic(access, async (c) => {
    let id = d.id;
    if (id) {
      // Archiving is its own action: editing a company's details never changes it.
      const u = await c.query(`update aesthetic_companies set name = $3, phone = $4, note = $5 where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
        d.name,
        d.phone,
        d.note,
      ]);
      if (!u.rowCount) return { error: "not_found" };
    } else {
      id = (
        await c.query(
          `insert into aesthetic_companies (clinic_id, name, phone, note, created_by, sort)
           values ($1, $2, $3, $4, $5, (select coalesce(max(sort), 0) + 1 from aesthetic_companies where clinic_id = $1)) returning id`,
          [access.clinicId, d.name, d.phone, d.note, access.session.user.id]
        )
      ).rows[0].id as string;
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "stock.company.update" : "stock.company.create",
      entity: "aesthetic_company",
      entityId: id!,
      detail: { name: d.name },
    });
    revalidatePath(`/c/${slug}/stock`);
    return lists(c, access.clinicId);
  });
}

const productSchema = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  companyId: z.string().uuid().nullable().default(null),
  treatments: z.array(z.string().max(64)).max(20).default([]),
  unit: z.enum(PRODUCT_UNITS as [string, ...string[]]),
  packSize: z.number().positive().max(100000),
  lowStock: z.number().min(0).max(1000000).nullable().default(null),
  lastCost: z.number().min(0).max(1000000).nullable().default(null),
  active: z.boolean().default(true),
});

export async function saveProductAction(slug: string, data: unknown): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  const parsed = productSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  return inClinic(access, async (c) => {
    // Only the face chart's treatments, the clinic's own included.
    const known = await clinicTreatmentKeys(c, access.clinicId);
    const treatments = [...new Set(d.treatments)].filter((k) => known.has(k));
    // A foreign key does not see row security: the company is checked against this clinic by hand.
    if (d.companyId && !(await c.query(`select 1 from aesthetic_companies where id = $1 and clinic_id = $2`, [d.companyId, access.clinicId])).rowCount) {
      return { error: "invalid" };
    }
    let id = d.id;
    const values = [d.name, d.companyId, treatments, d.unit, d.packSize, d.lowStock, d.lastCost, d.active];
    if (id) {
      /*
        What a product is counted in is fixed once it has moved: every batch, cost
        and chart entry is a number of those units, and 100 units does not become
        100 millilitres because a form said so. Pack size can change; it only
        decides how the next delivery is counted.
      */
      const was = (
        await c.query(
          `select p.unit, exists (select 1 from stock_moves m where m.product_id = p.id) as moved
             from aesthetic_products p where p.id = $1 and p.clinic_id = $2`,
          [id, access.clinicId]
        )
      ).rows[0];
      if (was?.moved && was.unit !== d.unit) return { error: "unit_locked" };
      const u = await c.query(
        `update aesthetic_products set name = $3, company_id = $4, treatments = $5, unit = $6, pack_size = $7, low_stock = $8, last_cost = $9, active = $10
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, ...values]
      );
      if (!u.rowCount) return { error: "not_found" };
      /*
        A product's own prices are named after it, "Toxin (Botox 100u)", and were
        left saying the old name: the price list and every new invoice line
        named a product the clinic no longer called that.
      */
      const own = (await c.query(`select id, chart_key from services where clinic_id = $1 and chart_variant = $2 and chart_owned`, [access.clinicId, id])).rows;
      for (const s of own) {
        const tr = await resolveTreatment(c, access.clinicId, s.chart_key);
        if (!tr) continue;
        await c.query(`update services set name = $2, name_ar = $3 where id = $1`, [
          s.id,
          `${tr.en} (${d.name})`.slice(0, 80),
          `${tr.ar} (${d.name})`.slice(0, 80),
        ]);
      }
    } else {
      id = (
        await c.query(
          `insert into aesthetic_products (clinic_id, name, company_id, treatments, unit, pack_size, low_stock, last_cost, active, created_by, sort)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (select coalesce(max(sort), 0) + 1 from aesthetic_products where clinic_id = $1)) returning id`,
          [access.clinicId, ...values, access.session.user.id]
        )
      ).rows[0].id as string;
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "stock.product.update" : "stock.product.create",
      entity: "aesthetic_product",
      entityId: id!,
      detail: { name: d.name, unit: d.unit, packSize: d.packSize },
    });
    revalidatePath(`/c/${slug}/stock`);
    return lists(c, access.clinicId);
  });
}

const receiveSchema = z.object({
  productId: z.string().uuid(),
  packs: z.number().positive().max(10000),
  packPrice: z.number().min(0).max(1000000),
  lot: z.string().trim().max(40).default(""),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  method: z.enum(["cash", "cliq", "card", "transfer", "cheque"]).default("cash"),
  note: z.string().trim().max(500).default(""),
});

/**
 * A delivery in: so many packs at a price each. The units go on hand as a new
 * batch, what one unit cost becomes the product's cost, and what was paid is
 * recorded as an expense under Supplies in the same step — so the clinic's
 * profit counts the money once, here, and a treatment's cost only decides its
 * doctor's share.
 *
 * Anything used before the delivery was recorded (on hand below zero) is
 * taken from the new batch, so the batch says what is really left in it.
 */
export async function receiveStockAction(slug: string, data: unknown): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  const parsed = receiveSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  return inClinic(access, async (c) => {
    const p = (
      await c.query(
        `select p.id, p.name, p.pack_size::float as pack_size, co.name as company
           from aesthetic_products p left join aesthetic_companies co on co.id = p.company_id
          where p.id = $1 and p.clinic_id = $2 and p.active for update of p`,
        [d.productId, access.clinicId]
      )
    ).rows[0];
    if (!p) return { error: "not_found" };
    const qty = Math.round(d.packs * p.pack_size * 100) / 100;
    const unitCost = Math.round((d.packPrice / p.pack_size) * 10000) / 10000;
    const total = Math.round(d.packs * d.packPrice * 100) / 100;
    const today = (await c.query(`select (now() at time zone timezone)::date::text as d from clinics where id = $1`, [access.clinicId])).rows[0].d as string;
    // A delivery entered late still belongs to the day it came. Not to a day still to come.
    const receivedOn = d.receivedOn && d.receivedOn <= today ? d.receivedOn : today;

    let expenseId: string | null = null;
    if (total > 0) {
      expenseId = (
        await c.query(
          `insert into expenses (clinic_id, category_id, amount, vendor, note, spent_on, method, created_by)
           values ($1, (select id from expense_categories where clinic_id = $1 and key = 'supplies' and active limit 1), $2, $3, $4, $5, $6, $7)
           returning id`,
          [
            access.clinicId,
            total,
            String(p.company ?? "").slice(0, 120),
            `${p.name} × ${d.packs}${d.lot ? ` · ${d.lot}` : ""}`.slice(0, 500),
            receivedOn,
            d.method,
            access.session.user.id,
          ]
        )
      ).rows[0].id as string;
    }
    const batch = (
      await c.query(
        `insert into stock_batches (clinic_id, product_id, lot, expires_on, received_on, qty, unit_cost, expense_id, note, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [access.clinicId, p.id, d.lot, d.expiresOn, receivedOn, qty, unitCost, expenseId, d.note, access.session.user.id]
      )
    ).rows[0].id as string;
    await c.query(`insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, by_user) values ($1, $2, $3, 'receive', $4, $5, $6)`, [
      access.clinicId,
      p.id,
      batch,
      qty,
      unitCost,
      access.session.user.id,
    ]);
    // Used before it was received: settle it from this batch.
    const owed = -Number((await c.query(`select coalesce(sum(qty), 0) as n from stock_moves where product_id = $1 and batch_id is null`, [p.id])).rows[0].n);
    if (owed > 0) {
      const take = Math.min(owed, qty);
      await c.query(
        `insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, by_user, reason)
         values ($1, $2, null, 'adjust', $3, 0, $5, 'received later'), ($1, $2, $4, 'adjust', $6, $7, $5, 'used before it was received')`,
        [access.clinicId, p.id, take, batch, access.session.user.id, -take, unitCost]
      );
    }
    await c.query(`update aesthetic_products set last_cost = $2 where id = $1`, [p.id, unitCost]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "stock.receive",
      entity: "aesthetic_product",
      entityId: p.id,
      detail: { batch, packs: d.packs, qty, unitCost, total, expense: expenseId },
    });
    revalidatePath(`/c/${slug}/stock`);
    return lists(c, access.clinicId);
  });
}

const adjustSchema = z.object({
  batchId: z.string().uuid(),
  onHand: z.number().min(0).max(1000000),
  reason: z.enum(["waste", "expired", "count"]),
  note: z.string().trim().max(250).default(""),
});

/** A batch's count put right: what is really on hand now, and why it changed. */
export async function adjustStockAction(slug: string, data: unknown): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  const parsed = adjustSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  return inClinic(access, async (c) => {
    const b = (
      await c.query(
        `select b.id, b.product_id, b.unit_cost, coalesce((select sum(m.qty) from stock_moves m where m.batch_id = b.id), 0)::float as on_hand
           from stock_batches b where b.id = $1 and b.clinic_id = $2`,
        [d.batchId, access.clinicId]
      )
    ).rows[0];
    if (!b) return { error: "not_found" };
    const delta = Math.round((d.onHand - b.on_hand) * 100) / 100;
    let moveId: string | undefined;
    if (delta !== 0) {
      moveId = (
        await c.query(
          `insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, by_user, reason) values ($1, $2, $3, 'adjust', $4, $5, $6, $7) returning id`,
          [access.clinicId, b.product_id, b.id, delta, b.unit_cost, access.session.user.id, `${d.reason}${d.note ? `: ${d.note}` : ""}`]
        )
      ).rows[0].id as string;
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "stock.adjust",
        entity: "aesthetic_product",
        entityId: b.product_id,
        detail: { batch: b.id, from: b.on_hand, to: d.onHand, reason: d.reason },
      });
    }
    revalidatePath(`/c/${slug}/stock`);
    return { ...(await lists(c, access.clinicId)), moveId };
  });
}

/** A correction taken back. Not once treatments have used what it added: the count would go below nothing. */
export async function undoAdjustAction(slug: string, moveId: string): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(moveId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const m = (
      await c.query(
        `select m.id, m.product_id, m.batch_id, m.qty::float as qty
           from stock_moves m
          where m.id = $1 and m.clinic_id = $2 and m.kind = 'adjust' and m.by_user = $3
            and m.at > now() - interval '${UNDO_WINDOW}'`,
        [moveId, access.clinicId, access.session.user.id]
      )
    ).rows[0];
    if (!m) return { error: "too_late" };
    await c.query(`select 1 from aesthetic_products where id = $1 for update`, [m.product_id]);
    const left = Number(
      (await c.query(`select coalesce(sum(qty), 0)::float as n from stock_moves where batch_id = $1`, [m.batch_id])).rows[0].n
    );
    if (left - m.qty < 0) return { error: "batch_used" };
    await c.query(`delete from stock_moves where id = $1`, [m.id]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "stock.adjust.undo",
      entity: "aesthetic_product",
      entityId: m.product_id,
      detail: { batch: m.batch_id, qty: m.qty },
    });
    revalidatePath(`/c/${slug}/stock`);
    return lists(c, access.clinicId);
  });
}

/**
 * A product off the list. One nothing has ever touched is really deleted. One with
 * deliveries or treatments behind it is archived: a doctor's share and a patient's
 * chart both reach back to it, so it can stop being offered but cannot stop having
 * been used. Its own price goes with it either way, or the price list would go on
 * selling something the clinic has stopped keeping.
 */
export async function deleteProductAction(slug: string, id: string): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const p = (await c.query(`select * from aesthetic_products where id = $1 and clinic_id = $2 for update`, [id, access.clinicId])).rows[0];
    if (!p) return { error: "not_found" };
    const used = (
      await c.query(
        `select exists (select 1 from stock_moves where product_id = $1)
              or exists (select 1 from stock_batches where product_id = $1)
              or exists (select 1 from chart_mark_products where product_id = $1) as used`,
        [id]
      )
    ).rows[0].used as boolean;
    await setProductPrices(c, access.clinicId, id, false);
    if (used) await c.query(`update aesthetic_products set active = false where id = $1`, [id]);
    else await c.query(`delete from aesthetic_products where id = $1`, [id]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: used ? "stock.product.archive" : "stock.product.delete",
      entity: "aesthetic_product",
      entityId: id,
      detail: used ? { name: p.name } : { name: p.name, row: p },
    });
    revalidatePath(`/c/${slug}/stock`);
    return { ...(await lists(c, access.clinicId)), outcome: used ? "archived" : "deleted" };
  });
}

/** Back in use, or back from being deleted. The second only for the person who did it, within the half hour. */
export async function restoreProductAction(slug: string, id: string): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const u = await c.query(`update aesthetic_products set active = true where id = $1 and clinic_id = $2`, [id, access.clinicId]);
    if (!u.rowCount) {
      const row = (await lastDelete(c, access, "stock.product.delete", id))?.row as Record<string, unknown> | undefined;
      if (!row) return { error: "too_late" };
      // The company may have gone since: the product comes back without one rather than not at all.
      const company = row.company_id
        ? (await c.query(`select id from aesthetic_companies where id = $1 and clinic_id = $2`, [row.company_id, access.clinicId])).rows[0]?.id ?? null
        : null;
      await c.query(
        `insert into aesthetic_products (id, clinic_id, company_id, name, treatments, unit, pack_size, low_stock, last_cost, active, sort, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11)`,
        [id, access.clinicId, company, row.name, row.treatments, row.unit, row.pack_size, row.low_stock, row.last_cost, row.sort, row.created_by]
      );
    }
    await setProductPrices(c, access.clinicId, id, true);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "stock.product.restore",
      entity: "aesthetic_product",
      entityId: id,
    });
    revalidatePath(`/c/${slug}/stock`);
    return lists(c, access.clinicId);
  });
}

/** A company off the list. One with any product, even an archived one, is archived too: that product still names it. */
export async function deleteCompanyAction(slug: string, id: string): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const co = (await c.query(`select * from aesthetic_companies where id = $1 and clinic_id = $2 for update`, [id, access.clinicId])).rows[0];
    if (!co) return { error: "not_found" };
    const used = !!(await c.query(`select 1 from aesthetic_products where company_id = $1 limit 1`, [id])).rowCount;
    if (used) await c.query(`update aesthetic_companies set active = false where id = $1`, [id]);
    else await c.query(`delete from aesthetic_companies where id = $1`, [id]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: used ? "stock.company.archive" : "stock.company.delete",
      entity: "aesthetic_company",
      entityId: id,
      detail: used ? { name: co.name } : { name: co.name, row: co },
    });
    revalidatePath(`/c/${slug}/stock`);
    return { ...(await lists(c, access.clinicId)), outcome: used ? "archived" : "deleted" };
  });
}

export async function restoreCompanyAction(slug: string, id: string): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const u = await c.query(`update aesthetic_companies set active = true where id = $1 and clinic_id = $2`, [id, access.clinicId]);
    if (!u.rowCount) {
      const row = (await lastDelete(c, access, "stock.company.delete", id))?.row as Record<string, unknown> | undefined;
      if (!row) return { error: "too_late" };
      await c.query(
        `insert into aesthetic_companies (id, clinic_id, name, phone, note, active, sort, created_by) values ($1, $2, $3, $4, $5, true, $6, $7)`,
        [id, access.clinicId, row.name, row.phone, row.note, row.sort, row.created_by]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "stock.company.restore",
      entity: "aesthetic_company",
      entityId: id,
    });
    revalidatePath(`/c/${slug}/stock`);
    return lists(c, access.clinicId);
  });
}

/**
 * A delivery taken back, for one entered by mistake. Only while nothing has
 * happened to it: once a treatment has used it, or a count has corrected it, or it
 * settled a shortfall, those are facts about the clinic and it stays.
 *
 * Its expense goes too, because that money was never spent. Unless somebody has
 * changed the expense or attached the bill since: then it is a record a person
 * has worked on, not a by-product of a mistake, so it stays and they are told.
 */
export async function deleteBatchAction(slug: string, batchId: string): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(batchId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const b = (await c.query(`select * from stock_batches where id = $1 and clinic_id = $2`, [batchId, access.clinicId])).rows[0];
    if (!b) return { error: "not_found" };
    const product = (await c.query(`select last_cost from aesthetic_products where id = $1 for update`, [b.product_id])).rows[0];
    const moves = (await c.query(`select * from stock_moves where batch_id = $1`, [batchId])).rows;
    if (moves.some((m) => m.kind !== "receive")) return { error: "batch_used" };

    const expense = b.expense_id ? (await c.query(`select * from expenses where id = $1 and clinic_id = $2`, [b.expense_id, access.clinicId])).rows[0] : null;
    const expenseGoes = !!expense && !expense.receipt_path && new Date(expense.updated_at).getTime() === new Date(expense.created_at).getTime();

    await c.query(`delete from stock_batches where id = $1`, [batchId]);
    if (expenseGoes) await c.query(`delete from expenses where id = $1`, [expense.id]);

    const newest = (
      await c.query(`select unit_cost from stock_batches where product_id = $1 order by received_on desc, created_at desc limit 1`, [b.product_id])
    ).rows[0];
    if (newest) await c.query(`update aesthetic_products set last_cost = $2 where id = $1`, [b.product_id, newest.unit_cost]);

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "stock.batch.delete",
      entity: "stock_batch",
      entityId: batchId,
      detail: { batch: b, moves, expense: expenseGoes ? expense : null, expenseId: expense?.id ?? null, lastCost: product?.last_cost ?? null },
    });
    revalidatePath(`/c/${slug}/stock`);
    revalidatePath(`/c/${slug}/expenses`);
    return { ...(await lists(c, access.clinicId)), outcome: "deleted", expenseKept: !!expense && !expenseGoes };
  });
}

export async function restoreBatchAction(slug: string, batchId: string): Promise<Answer> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(batchId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const d = await lastDelete(c, access, "stock.batch.delete", batchId);
    if (!d) return { error: "too_late" };
    const b = d.batch as Record<string, unknown>;
    const moves = d.moves as Record<string, unknown>[];
    const e = d.expense as Record<string, unknown> | null;
    const product = (await c.query(`select id from aesthetic_products where id = $1 and clinic_id = $2 for update`, [b.product_id, access.clinicId])).rows[0];
    if (!product) return { error: "too_late" };
    if (e) {
      await c.query(
        `insert into expenses (id, clinic_id, category_id, amount, vendor, note, spent_on, method, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [e.id, access.clinicId, e.category_id, e.amount, e.vendor, e.note, String(e.spent_on).slice(0, 10), e.method, e.created_by]
      );
    }
    const kept = d.expenseId ? (await c.query(`select id from expenses where id = $1 and clinic_id = $2`, [d.expenseId, access.clinicId])).rows[0]?.id ?? null : null;
    await c.query(
      `insert into stock_batches (id, clinic_id, product_id, lot, expires_on, received_on, qty, unit_cost, expense_id, note, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        batchId,
        access.clinicId,
        b.product_id,
        b.lot,
        b.expires_on ? String(b.expires_on).slice(0, 10) : null,
        String(b.received_on).slice(0, 10),
        b.qty,
        b.unit_cost,
        kept,
        b.note,
        b.created_by,
      ]
    );
    for (const m of moves) {
      await c.query(
        `insert into stock_moves (id, clinic_id, product_id, batch_id, kind, qty, unit_cost, reason, by_user, at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [m.id, access.clinicId, m.product_id, batchId, m.kind, m.qty, m.unit_cost, m.reason, m.by_user, m.at]
      );
    }
    if (d.lastCost != null) await c.query(`update aesthetic_products set last_cost = $2 where id = $1`, [b.product_id, d.lastCost]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "stock.batch.restore",
      entity: "stock_batch",
      entityId: batchId,
    });
    revalidatePath(`/c/${slug}/stock`);
    revalidatePath(`/c/${slug}/expenses`);
    return lists(c, access.clinicId);
  });
}

/** What happened to a product, for its history. A patient's name needs `patients`, which `stock` does not bring. */
export async function productHistoryAction(slug: string, id: string): Promise<{ moves?: StockMove[]; error?: string }> {
  const access = await guard(slug);
  if (!access) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => ({ moves: await loadProductMoves(c, access.clinicId, id, can(access, "patients")) }));
}
