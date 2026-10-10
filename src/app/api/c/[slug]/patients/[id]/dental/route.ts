import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { loadDentalChart } from "@/lib/charts/dental/db";

/*
  The patient's chart, read again.

  The file holds the chart for as long as it is open (components/charts/dental
  /store.tsx) and asks for it again only when the copy it holds may be old:
  the browser brought the page back from its history without asking the
  server, or a colleague changed the chart on another screen. The patient's
  files come with it, with the teeth each x-ray or photo is pinned to, because
  they are drawn on the same chart.

  Not a new look at the file for the read trail: the page that holds the chart
  was the look, and was recorded when it opened.
*/
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;
  if (!access.clinic.features.dental) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return null;
    const chart = await loadDentalChart(c, access.clinicId, id);
    // Insurance cards stay with whoever handles insurance, as on the page itself.
    const files = await c.query(
      `select id, file_name, mime_type, size_bytes, kind, created_at, teeth
         from patient_files
        where patient_id = $1 and clinic_id = $2${can(access, "insurance") ? "" : " and kind <> 'insurance_card'"}
        order by created_at desc`,
      [id, access.clinicId]
    );
    return { chart, files: files.rows };
  });

  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...result });
}
