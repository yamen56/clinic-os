import { NextResponse } from "next/server";
import { z } from "zod";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { CUSTOM_CATEGORIES, CUSTOM_LOOKS, CUSTOM_SCOPES, toCustomTreatment } from "@/lib/charts/dental/db";
import type { Category, Look, Scope } from "@/lib/charts/dental/catalog";

/*
  A treatment of the clinic's own, added from the chart by whoever needed it.
  It joins the catalog for every doctor in the clinic, with that person's name
  on it, and borrows its drawing from a built-in so it still shows on a tooth.
*/

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  abbr: z.string().trim().max(8).optional().default(""),
  category: z.enum(CUSTOM_CATEGORIES as [Category, ...Category[]]),
  scope: z.enum(CUSTOM_SCOPES as [Scope, ...Scope[]]),
  look: z.enum(CUSTOM_LOOKS as [Look, ...Look[]]),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;
  // A surface treatment with no shape of its own reads as a filling on those surfaces.
  const look: Look = d.scope === "surface" && d.look === "dot" ? "filling" : d.look;

  const row = await inClinic(access, async (c) => {
    const r = await c.query(
      `insert into chart_treatments (clinic_id, chart, category, name, abbr, scope, look, created_by)
       values ($1, 'dental', $2, $3, $4, $5, $6, $7) returning *`,
      [access.clinicId, d.category, d.name, d.abbr || null, d.scope, look, access.session.user.id]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.treatment.create",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { name: d.name, category: d.category, scope: d.scope },
    });
    return { ...r.rows[0], creator_name: access.session.user.fullName };
  });
  return NextResponse.json({ ok: true, treatment: toCustomTreatment(row) });
}
