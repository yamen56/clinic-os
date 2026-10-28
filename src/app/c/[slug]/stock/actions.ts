"use server";

/*
  Products and stock for the face chart (0085): the companies, the products,
  deliveries in and corrections. Every action is `stock` on a clinic with the
  face chart, and answers with the lists as they now stand, so the screen
  shows what was saved without asking again.
*/

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic, can, type ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { FACE_TREATMENT_BY_KEY } from "@/lib/charts/face/catalog";
import { PRODUCT_UNITS, loadCompanies, loadStockProducts, type Company, type StockProduct } from "@/lib/charts/face/stock";
import type { PoolClient } from "pg";

type Answer = { products?: StockProduct[]; companies?: Company[]; error?: string };

async function guard(slug: string): Promise<ClinicAccess | null> {
  const access = await requireClinic(slug);
  if (!can(access, "stock") || !access.clinic.features.aesthetic) return null;
  return access;
}

async function lists(c: PoolClient, clinicId: string): Promise<Answer> {
  return { products: await loadStockProducts(c, clinicId, { withBatches: true }), companies: await loadCompanies(c, clinicId) };
}

const companySchema = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).default(""),
  note: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
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
      const u = await c.query(`update aesthetic_companies set name = $3, phone = $4, note = $5, active = $6 where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
        d.name,
        d.phone,
        d.note,
        d.active,
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
  // Only the face chart's own treatments.
  const treatments = [...new Set(d.treatments)].filter((k) => FACE_TREATMENT_BY_KEY.has(k));
  return inClinic(access, async (c) => {
    // A foreign key does not see row security: the company is checked against this clinic by hand.
    if (d.companyId && !(await c.query(`select 1 from aesthetic_companies where id = $1 and clinic_id = $2`, [d.companyId, access.clinicId])).rowCount) {
      return { error: "invalid" };
    }
    let id = d.id;
    const values = [d.name, d.companyId, treatments, d.unit, d.packSize, d.lowStock, d.lastCost, d.active];
    if (id) {
      const u = await c.query(
        `update aesthetic_products set name = $3, company_id = $4, treatments = $5, unit = $6, pack_size = $7, low_stock = $8, last_cost = $9, active = $10
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, ...values]
      );
      if (!u.rowCount) return { error: "not_found" };
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
          where p.id = $1 and p.clinic_id = $2 for update of p`,
        [d.productId, access.clinicId]
      )
    ).rows[0];
    if (!p) return { error: "not_found" };
    const qty = Math.round(d.packs * p.pack_size * 100) / 100;
    const unitCost = Math.round((d.packPrice / p.pack_size) * 10000) / 10000;
    const total = Math.round(d.packs * d.packPrice * 100) / 100;
    const today = (await c.query(`select (now() at time zone timezone)::date::text as d from clinics where id = $1`, [access.clinicId])).rows[0].d as string;

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
            today,
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
        [access.clinicId, p.id, d.lot, d.expiresOn, today, qty, unitCost, expenseId, d.note, access.session.user.id]
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
    if (delta !== 0) {
      await c.query(
        `insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, by_user, reason) values ($1, $2, $3, 'adjust', $4, $5, $6, $7)`,
        [access.clinicId, b.product_id, b.id, delta, b.unit_cost, access.session.user.id, `${d.reason}${d.note ? `: ${d.note}` : ""}`]
      );
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
    return lists(c, access.clinicId);
  });
}
