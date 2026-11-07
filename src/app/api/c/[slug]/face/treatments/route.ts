import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { FACE_TREATMENT_BY_KEY, isZone } from "@/lib/charts/face/catalog";
import { CUSTOM_PREFIX, customKey, loadClinicTreatments, resolveTreatment } from "@/lib/charts/face/treatments";

/*
  The clinic's own face treatments and their variants (0094).

  A doctor adds one from the chart, at the chair, as readily as from Settings:
  whoever records on the face chart, or sets the clinic's prices. Never deleted,
  because past entries name them: archived, and a variant made inactive. Every
  answer is the whole list as it now stands, so the chart and the price page
  draw from the same thing.
*/

const FAMILIES = ["toxin", "filler", "skin", "laser", "threads", "contour"] as const;
const PRICED = ["area", "unit", "syringe", "thread", "session"] as const;
const name = z.string().trim().min(1).max(80);
const nameAr = z.string().trim().max(80).nullish().transform((v) => (v ? v : null));

const op = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    name,
    nameAr,
    family: z.enum(FAMILIES),
    pricedBy: z.enum(PRICED),
    fits: z.array(z.string().max(24)).min(1).max(60),
    units: z.boolean().default(false),
  }),
  z.object({ op: z.literal("rename"), key: z.string().max(64), name, nameAr }),
  z.object({ op: z.literal("archive"), key: z.string().max(64), archived: z.boolean() }),
  z.object({ op: z.literal("variant"), treatmentKey: z.string().max(64), name: z.string().trim().min(1).max(60), nameAr, productId: z.string().uuid().nullish() }),
  z.object({ op: z.literal("variant_off"), id: z.string().uuid(), active: z.boolean() }),
]);

async function gate(slug: string) {
  return apiClinic(slug, ["patients.charts", "settings.services"], { module: "aesthetic" });
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await gate(slug);
  if (!g.ok) return g.res;
  return NextResponse.json(await inClinic(g.access, (c) => loadClinicTreatments(c, g.access.clinicId)));
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await gate(slug);
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = op.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const result = await inClinic(access, async (c) => {
    if (d.op === "create") {
      const fits = [...new Set(d.fits)];
      if (!fits.every(isZone)) return { error: "invalid" };
      // Counted per unit means dosed in units, or every entry would count as one.
      const units = d.units || d.pricedBy === "unit";
      const clash = await c.query(
        `select 1 from aesthetic_treatments where clinic_id = $1 and archived_at is null and ar_normalize(name) = ar_normalize($2)`,
        [access.clinicId, d.name]
      );
      const builtIn = [...FACE_TREATMENT_BY_KEY.values()].some((t) => t.en.toLowerCase() === d.name.toLowerCase());
      if (clash.rowCount || builtIn) return { error: "exists" };
      const id = randomUUID();
      await c.query(
        `insert into aesthetic_treatments (id, clinic_id, key, name, name_ar, family, priced_by, fits, units, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, access.clinicId, customKey(id), d.name, d.nameAr, d.family, d.pricedBy, fits, units, access.session.user.id]
      );
      await audit(c, { clinicId: access.clinicId, userId: access.session.user.id, impersonatedBy: access.session.impersonatedBy, action: "face.treatment.create", entity: "aesthetic_treatment", entityId: id, detail: { name: d.name, family: d.family, pricedBy: d.pricedBy } });
      return { key: customKey(id) };
    }
    if (d.op === "rename" || d.op === "archive") {
      if (!d.key.startsWith(CUSTOM_PREFIX)) return { error: "invalid" };
      const r =
        d.op === "rename"
          ? await c.query(`update aesthetic_treatments set name = $3, name_ar = $4 where clinic_id = $1 and key = $2`, [access.clinicId, d.key, d.name, d.nameAr])
          : await c.query(`update aesthetic_treatments set archived_at = case when $3 then now() else null end where clinic_id = $1 and key = $2`, [access.clinicId, d.key, d.archived]);
      if (!r.rowCount) return { error: "not_found" };
      if (d.op === "rename") {
        // Its prices are named after it too: the treatment's own, and each variant's.
        const own = await c.query(`select id, chart_variant from services where clinic_id = $1 and chart_key = $2 and chart_owned`, [access.clinicId, d.key]);
        for (const s of own.rows) {
          const v = s.chart_variant ? (await c.query(`select name from aesthetic_treatment_variants where id::text = $1`, [s.chart_variant])).rows[0]?.name : null;
          await c.query(`update services set name = $2, name_ar = $3 where id = $1`, [s.id, (v ? `${d.name} (${v})` : d.name).slice(0, 80), (v ? `${d.nameAr ?? d.name} (${v})` : (d.nameAr ?? d.name)).slice(0, 80)]);
        }
      } else {
        await c.query(`update services set active = $3 where clinic_id = $1 and chart_key = $2 and chart_owned`, [access.clinicId, d.key, !d.archived]);
      }
      await audit(c, { clinicId: access.clinicId, userId: access.session.user.id, impersonatedBy: access.session.impersonatedBy, action: `face.treatment.${d.op}`, entity: "aesthetic_treatment", entityId: d.key, detail: d });
      return { key: d.key };
    }
    if (d.op === "variant") {
      const t = await resolveTreatment(c, access.clinicId, d.treatmentKey);
      if (!t || t.archived) return { error: "invalid" };
      if (d.productId && !(await c.query(`select 1 from aesthetic_products where id = $1 and clinic_id = $2`, [d.productId, access.clinicId])).rowCount) return { error: "invalid" };
      const clash = await c.query(
        `select 1 from aesthetic_treatment_variants where clinic_id = $1 and treatment_key = $2 and active and ar_normalize(name) = ar_normalize($3)`,
        [access.clinicId, t.key, d.name]
      );
      if (clash.rowCount) return { error: "exists" };
      const id = (
        await c.query(
          `insert into aesthetic_treatment_variants (clinic_id, treatment_key, name, name_ar, product_id, created_by, sort)
           values ($1, $2, $3, $4, $5, $6, (select coalesce(max(sort), 0) + 1 from aesthetic_treatment_variants where clinic_id = $1 and treatment_key = $2))
           returning id`,
          [access.clinicId, t.key, d.name, d.nameAr, d.productId ?? null, access.session.user.id]
        )
      ).rows[0].id as string;
      await audit(c, { clinicId: access.clinicId, userId: access.session.user.id, impersonatedBy: access.session.impersonatedBy, action: "face.variant.create", entity: "aesthetic_treatment", entityId: t.key, detail: { variant: id, name: d.name } });
      return { variantId: id };
    }
    const r = await c.query(`update aesthetic_treatment_variants set active = $3 where id = $1 and clinic_id = $2`, [d.id, access.clinicId, d.active]);
    if (!r.rowCount) return { error: "not_found" };
    await c.query(`update services set active = $3 where clinic_id = $1 and chart_variant = $2 and chart_owned`, [access.clinicId, d.id, d.active]);
    return { variantId: d.id };
  });

  if ("error" in result) return NextResponse.json(result, { status: result.error === "not_found" ? 404 : result.error === "exists" ? 409 : 400 });
  const lists = await inClinic(access, (c) => loadClinicTreatments(c, access.clinicId));
  return NextResponse.json({ ok: true, ...result, ...lists });
}
