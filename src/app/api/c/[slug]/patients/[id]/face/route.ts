import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { loadFaceChart } from "@/lib/charts/face/db";

/*
  The patient's face chart, read again: when a colleague recorded on it from
  another screen, or invoices made from it changed what is billed.
*/
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients", { module: "aesthetic" });
  if (!g.ok) return g.res;
  const access = g.access;

  const chart = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2`, [id, access.clinicId]);
    if (!p.rowCount) return null;
    return loadFaceChart(c, access.clinicId, id, { billing: can(access, "invoices") });
  });
  if (!chart) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, chart });
}
