"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { FACE_TREATMENT_BY_KEY, feeOf, pickFacePrice } from "@/lib/charts/face/catalog";
import { loadFacePrices, type FacePrice } from "@/lib/charts/face/db";

const schema = z.object({
  key: z.string().min(1).max(64),
  /** A product's own price for the treatment; null for the treatment's price. */
  productId: z.string().uuid().nullable().default(null),
  price: z.number().min(0).max(1_000_000).nullable(),
});

/**
 * A face treatment's price, as a service — what one area, syringe, thread or
 * session costs; the chart multiplies it by what the treatment counts. A
 * product may have its own (a Juvederm syringe dearer than another filler),
 * as a service of the same treatment with the product as its variant.
 *
 * Typing a price makes the service (named from the catalog in both languages,
 * and the product's name, not offered on the booking page) or updates it.
 * Clearing the box retires that service: its past invoices keep it.
 *
 * The treatments already recorded with no price, done and not billed, take
 * the price now — each at its own quantity, with its own product.
 */
export async function saveFacePriceAction(slug: string, data: unknown): Promise<{ row?: FacePrice | null; priced?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!access.clinic.features.aesthetic) return { error: "forbidden" };
  const parsed = schema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const t = FACE_TREATMENT_BY_KEY.get(d.key);
  if (!t) return { error: "invalid" };

  return inClinic(access, async (c) => {
    let product: { name: string } | null = null;
    if (d.productId) {
      product = (await c.query(`select name from aesthetic_products where id = $1 and clinic_id = $2 and $3 = any(treatments)`, [d.productId, access.clinicId, t.key])).rows[0] ?? null;
      if (!product) return { error: "invalid" };
    }
    const cur = (
      await c.query(
        `select id, name, name_ar from services
          where clinic_id = $1 and chart_key = $2 and coalesce(chart_variant, '') = coalesce($3, '') and price_unit = 'item'`,
        [access.clinicId, t.key, d.productId]
      )
    ).rows[0];

    let row: FacePrice | null = null;
    if (d.price === null) {
      if (cur) await c.query(`update services set active = false, chart_key = null, chart_variant = null where id = $1`, [cur.id]);
    } else if (cur) {
      await c.query(`update services set price = $2, active = true where id = $1`, [cur.id, d.price]);
      row = { serviceId: cur.id, chartKey: t.key, variant: d.productId, price: d.price, name: cur.name, nameAr: cur.name_ar ?? null };
    } else {
      // Filed with the clinic's aesthetics section when it keeps one; otherwise unfiled, like any new service.
      const section =
        (
          await c.query(
            `select id from service_sections
              where clinic_id = $1 and active
                and (name ilike '%aesthet%' or name ilike '%cosmet%' or name ilike '%derma%' or coalesce(name_ar, '') like '%تجميل%')
              order by sort limit 1`,
            [access.clinicId]
          )
        ).rows[0]?.id ?? null;
      const names = product ? { en: `${t.en} (${product.name})`, ar: `${t.ar} (${product.name})` } : { en: t.en, ar: t.ar };
      const ins = await c.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online, section_id,
                               chart_key, chart_variant, price_unit, chart_owned, sort)
         values ($1, $2, $3, 30, $4, false, $5, $6, $7, 'item', true,
                 (select coalesce(max(sort), 0) + 1 from services where clinic_id = $1))
         returning id`,
        [access.clinicId, names.en.slice(0, 80), names.ar.slice(0, 80), d.price, section, t.key, d.productId]
      );
      row = { serviceId: ins.rows[0].id, chartKey: t.key, variant: d.productId, price: d.price, name: names.en, nameAr: names.ar };
    }

    // The ones waiting for a price: done, standing, never priced by hand, on no invoice, not from a package.
    let priced = 0;
    if (row) {
      const list = await loadFacePrices(c, access.clinicId, t.key);
      const waiting = (
        await c.query(
          `select m.id, m.quantity, (select cmp.product_id from chart_mark_products cmp where cmp.mark_id = m.id limit 1) as product_id
             from chart_marks m
            where m.clinic_id = $1 and m.chart = 'aesthetic' and m.treatment_key = $2
              and m.fee is null and not m.fee_manual and m.voided_at is null and m.package_item_id is null
              and not exists (select 1 from invoice_item_marks iim where iim.mark_id = m.id)`,
          [access.clinicId, t.key]
        )
      ).rows as { id: string; quantity: string | null; product_id: string | null }[];
      for (const m of waiting) {
        const p = pickFacePrice(list, t.key, m.product_id);
        if (!p) continue;
        const fee = feeOf(p.price, Number(m.quantity ?? 1));
        await c.query(
          `with upd as (update chart_marks set fee = $1, service_id = $2 where id = $3 and clinic_id = $4 returning id, clinic_id)
           insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) select clinic_id, id, 'fee', $5, $6 from upd`,
          [fee, p.serviceId, m.id, access.clinicId, access.session.user.id, String(fee)]
        );
        priced++;
      }
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "service.face_price",
      entity: "service",
      entityId: row?.serviceId ?? cur?.id ?? "",
      detail: { key: t.key, product: d.productId, price: d.price, priced },
    });
    revalidatePath(`/c/${slug}/settings/face-prices`);
    return { row, priced };
  });
}
