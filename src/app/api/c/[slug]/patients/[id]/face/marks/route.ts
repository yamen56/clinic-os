import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { todaysVisit } from "@/lib/charts/dental/server";
import { toEvent } from "@/lib/charts/dental/db";
import { FACE_MARK_SELECT, loadFacePrices, toFaceMark } from "@/lib/charts/face/db";
import { FACE_TREATMENT_BY_KEY, feeOf, inFaceOrder, isZone, pickFacePrice, quantityOf } from "@/lib/charts/face/catalog";
import { takeStock } from "@/lib/charts/face/stock";
import { usablePackageItem } from "@/lib/charts/face/packages";

/*
  Recording a treatment on the face chart: what was done, on which parts of
  the face, how much, with which product — done now, at today's visit.

  The browser chooses the id, so the area it already coloured and the row
  stored here are the same entry from the first moment. The treatment's name,
  its family and what its price counts come from the catalog here, never from
  the request; its price comes from the clinic's list (with this product, when
  the list prices it by product), a snapshot so a later change to the list
  never rewrites a quote.

  A product used takes its units from stock — the batch that expires first —
  and its cost is frozen on the treatment for the doctor's share. A session
  from a package costs the patient nothing more; it earns its doctor the
  session's part of the package, at the doctor's deal frozen here.
*/

const bodySchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  treatmentKey: z.string().min(1).max(64),
  areas: z
    .array(z.object({ zone: z.string().max(24), units: z.number().int().min(0).max(1000).optional() }))
    .min(1)
    .max(24),
  /** Syringes or threads, for a treatment priced by them. */
  count: z.number().int().min(1).max(100).default(1),
  performedBy: z.string().uuid().nullish(),
  note: z.string().max(2000).default(""),
  /** The product used, and how much of it in the product's own unit. */
  product: z.object({ id: z.string().uuid(), qty: z.number().positive().max(100000) }).nullish(),
  /** A session from one of the patient's packages. */
  packageItemId: z.string().uuid().nullish(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts", { module: "aesthetic" });
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const t = FACE_TREATMENT_BY_KEY.get(d.treatmentKey);
  if (!t) return NextResponse.json({ error: "unknown_treatment" }, { status: 400 });
  // Each area once, a real one, one this treatment is done on.
  const zones = d.areas.map((a) => a.zone);
  if (new Set(zones).size !== zones.length || !zones.every((z) => isZone(z) && t.fits.includes(z))) {
    return NextResponse.json({ error: "invalid_area" }, { status: 400 });
  }
  // Units only where the treatment is dosed in them.
  const areas = inFaceOrder(d.areas.map((a) => (t.units ? { zone: a.zone, units: a.units ?? 0 } : { zone: a.zone })));

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" as const };

    // A foreign key does not see row security: the doctor and the product are checked against this clinic by hand.
    let deal: { rate: number | null; rule: string } = { rate: null, rule: "shared" };
    if (d.performedBy) {
      const ok = (await c.query(`select commission_percent, costs_rule from clinic_members where id = $1 and clinic_id = $2`, [d.performedBy, access.clinicId])).rows[0];
      if (!ok) return { error: "invalid_performer" as const };
      deal = { rate: ok.commission_percent == null ? null : Number(ok.commission_percent), rule: ok.costs_rule ?? "shared" };
    }
    if (d.product) {
      const ok = await c.query(`select 1 from aesthetic_products where id = $1 and clinic_id = $2 and active and $3 = any(treatments)`, [
        d.product.id,
        access.clinicId,
        t.key,
      ]);
      if (!ok.rowCount) return { error: "invalid_product" as const };
    }
    if (d.packageItemId) {
      const item = await usablePackageItem(c, access.clinicId, id, d.packageItemId, t.key);
      if ("error" in item) return { error: item.error };
    }

    const visit = await todaysVisit(c, access.clinicId, id, null, d.performedBy ?? null);
    const price = pickFacePrice(await loadFacePrices(c, access.clinicId, t.key), t.key, d.product?.id ?? null);
    const quantity = quantityOf(t, areas, d.count);
    // From a package: paid for in the package, so nothing more to bill.
    const fee = d.packageItemId ? 0 : feeOf(price?.price ?? null, quantity);
    await c.query(
      `insert into chart_marks (id, clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, detail, status,
                                performed_by, recorded_by, done_at, appointment_id, fee, service_id, note, areas, quantity,
                                package_item_id, commission_percent, costs_rule)
       values ($1, $2, $3, 'aesthetic', 'face', $4, $5, $6, $7, 'procedure', '{}', 'done',
               $8, $9, now(), $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        d.id,
        access.clinicId,
        id,
        t.key,
        t.en,
        t.ar,
        t.family,
        d.performedBy ?? null,
        access.session.user.id,
        visit,
        fee,
        price?.serviceId ?? null,
        d.note,
        // jsonb from JS is stringified by hand, or an array goes out as a PG array literal.
        JSON.stringify(areas),
        quantity,
        d.packageItemId ?? null,
        // The deal is frozen only on a package session: any other work freezes it on its invoice line.
        d.packageItemId ? deal.rate : null,
        d.packageItemId ? deal.rule : null,
      ]
    );
    if (d.product) await takeStock(c, access.clinicId, d.product.id, d.product.qty, d.id, access.session.user.id);
    await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user) values ($1, $2, $3, 'created', $4)`, [
      d.eventId,
      access.clinicId,
      d.id,
      access.session.user.id,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "face.mark.create",
      entity: "patient",
      entityId: id,
      detail: { mark: d.id, treatment: t.key, areas: zones, quantity, ...(d.product ? { product: d.product } : {}), ...(d.packageItemId ? { packageItem: d.packageItemId } : {}) },
    });
    const mark = (await c.query(`${FACE_MARK_SELECT} where m.id = $1 and m.clinic_id = $2`, [d.id, access.clinicId])).rows[0];
    const events = await c.query(
      `select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.mark_id = $1 and e.clinic_id = $2`,
      [d.id, access.clinicId]
    );
    return { mark: toFaceMark(mark), events: events.rows.map(toEvent) };
  });

  if ("error" in result) {
    const error = String(result.error);
    // A package with no session left, or run out, is a conflict with what the screen showed, not a bad request.
    return NextResponse.json({ error }, { status: error === "not_found" ? 404 : error.startsWith("package") ? 409 : 400 });
  }
  return NextResponse.json({ ok: true, ...result });
}
