import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { patientSearchClause } from "@/lib/patients";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });

  const results = await inClinic(g.access, async (c) => {
    const { clause, params } = patientSearchClause(q, 2);
    const r = await c.query(
      `select p.id, p.full_name, p.phone_e164, p.status, p.tags
       from patients p
       where p.clinic_id = $1 and p.merged_into is null and ${clause}
       order by p.updated_at desc limit 10`,
      [g.access.clinicId, ...params]
    );
    return r.rows;
  });
  return NextResponse.json({ results });
}
