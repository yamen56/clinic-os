import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { patientSearchClause } from "@/lib/patients";
import { can } from "@/lib/auth";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  // Backs the calendar, the invoice builder, the automation editor and the
  // waitlist as well as the patient list, so the gate is "may they look a
  // patient up at all" rather than any one screen's capability.
  const g = await apiClinic(slug, ["patients", "calendar", "invoices", "conversations", "automations"]);
  if (!g.ok) return g.res;
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });

  /*
    The next visit, for whoever may see the calendar: the search box in the
    header answers "when is she coming" without opening anything.
  */
  const next = can(g.access, "calendar")
    ? `(select min(a.starts_at) from appointments a
          where a.patient_id = p.id and a.starts_at > now()
            and a.status in ('pending_approval', 'scheduled', 'confirmed')) as next_at`
    : "null::timestamptz as next_at";
  const results = await inClinic(g.access, async (c) => {
    const { clause, params } = patientSearchClause(q, 2);
    const r = await c.query(
      `select p.id, p.full_name, p.phone_e164, p.status, p.tags, p.file_no, ${next}
       from patients p
       where p.clinic_id = $1 and p.merged_into is null and ${clause}
       order by p.updated_at desc limit 10`,
      [g.access.clinicId, ...params]
    );
    return r.rows;
  });
  return NextResponse.json({ results });
}
