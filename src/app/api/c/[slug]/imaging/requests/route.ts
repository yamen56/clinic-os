import { NextResponse } from "next/server";
import { z } from "zod";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

/*
  "Take x-ray": the doctor arms the imaging station from the chart, for this
  patient and these teeth; the station — a browser on the computer beside the
  x-ray machine — asks here for what is waiting and answers it with the next
  image the x-ray software saves.

  A request is waiting for twenty minutes. Longer than that, the patient has
  left the chair, and an image arriving then belongs to somebody else.
*/

const OPEN_FOR = "20 minutes";

const bodySchema = z.object({
  patientId: z.string().uuid(),
  teeth: z.array(z.string().regex(/^[1-8][1-8]$/)).max(32).default([]),
  kind: z.enum(["xray", "photo"]).default("xray"),
});

/** What the station is waiting for, oldest first. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const rows = await inClinic(g.access, async (c) =>
    (
      await c.query(
        `select r.id, r.patient_id, r.teeth, r.kind, r.created_at, p.full_name as patient_name, u.full_name as requested_by_name
           from imaging_requests r
           join patients p on p.id = r.patient_id
           left join users u on u.id = r.requested_by
          where r.clinic_id = $1 and r.fulfilled_at is null and r.cancelled_at is null
            and r.created_at > now() - interval '${OPEN_FOR}'
          order by r.created_at`,
        [g.access.clinicId]
      )
    ).rows
  );
  return NextResponse.json({ requests: rows });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const row = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [d.patientId, access.clinicId]);
    if (!p.rowCount) return null;
    const r = await c.query(
      `insert into imaging_requests (clinic_id, patient_id, teeth, kind, requested_by) values ($1, $2, $3, $4, $5)
       returning id, patient_id, teeth, kind, created_at`,
      [access.clinicId, d.patientId, d.teeth, d.kind, access.session.user.id]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "imaging.request",
      entity: "patient",
      entityId: d.patientId,
      detail: { teeth: d.teeth, kind: d.kind },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, request: row });
}
