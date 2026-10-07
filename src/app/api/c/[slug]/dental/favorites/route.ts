import { NextResponse } from "next/server";
import { z } from "zod";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { resolveTreatment } from "@/lib/charts/dental/db";

/*
  The clinic's favourite treatments: one list, shared by every doctor, each
  favourite saying who added it. Starring adds; un-starring removes. Both are
  in the audit log, because a shared list someone else rearranged should be
  explainable.
*/

const bodySchema = z.object({ key: z.string().min(1).max(64), on: z.boolean() });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { key, on } = parsed.data;

  const result = await inClinic(access, async (c) => {
    if (!(await resolveTreatment(c, access.clinicId, key))) return { error: "unknown_treatment" as const };
    if (on) {
      await c.query(
        `insert into chart_treatment_favorites (clinic_id, chart, treatment_key, sort, added_by)
         values ($1, 'dental', $2, coalesce((select max(sort) + 1 from chart_treatment_favorites where clinic_id = $1 and chart = 'dental'), 0), $3)
         on conflict (clinic_id, chart, treatment_key) do nothing`,
        [access.clinicId, key, access.session.user.id]
      );
    } else {
      await c.query(`delete from chart_treatment_favorites where clinic_id = $1 and chart = 'dental' and treatment_key = $2`, [access.clinicId, key]);
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: on ? "dental.favorite.add" : "dental.favorite.remove",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { treatment: key },
    });
    return { ok: true as const };
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
