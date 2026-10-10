import { NextResponse } from "next/server";
import { z } from "zod";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { IMAGING_REQUEST_OPEN_FOR } from "@/lib/imaging/ingest";

/*
  "Take x-ray": the doctor arms the imaging station from the chart, for this
  patient and these teeth; the station — a browser on the computer beside the
  x-ray machine — asks here for what is waiting and answers it with the next
  image the x-ray software saves.

  A request is waiting for twenty minutes. Longer than that, the patient has
  left the chair, and an image arriving then belongs to somebody else.
*/

const OPEN_FOR = IMAGING_REQUEST_OPEN_FOR;

const bodySchema = z.object({
  patientId: z.string().uuid(),
  teeth: z.array(z.string().regex(/^[1-8][1-8]$/)).max(32).default([]),
  kind: z.enum(["xray", "photo", "file"]).default("xray"),
  /** The machine asked: only its next result answers. None — whichever machine sends next. */
  deviceId: z.string().uuid().nullable().default(null),
  note: z.string().trim().max(80).default(""),
});

/** What the station is waiting for, oldest first. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const rows = await inClinic(g.access, async (c) =>
    (
      await c.query(
        `select r.id, r.patient_id, r.teeth, r.kind, r.created_at, r.note, r.device_id, d.name as device_name,
                p.full_name as patient_name, u.full_name as requested_by_name
           from imaging_requests r
           join patients p on p.id = r.patient_id
           left join users u on u.id = r.requested_by
           left join clinic_devices d on d.id = r.device_id
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
  // Asking a machine for a patient's result is part of their file: whoever opens files may.
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const row = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [d.patientId, access.clinicId]);
    if (!p.rowCount) return null;
    if (d.deviceId) {
      const dev = await c.query(`select 1 from clinic_devices where id = $1 and clinic_id = $2 and revoked_at is null`, [d.deviceId, access.clinicId]);
      if (!dev.rowCount) return null;
    }
    const r = await c.query(
      `insert into imaging_requests (clinic_id, patient_id, teeth, kind, requested_by, device_id, note) values ($1, $2, $3, $4, $5, $6, $7)
       returning id, patient_id, teeth, kind, created_at, device_id, note`,
      [access.clinicId, d.patientId, d.teeth, d.kind, access.session.user.id, d.deviceId, d.note]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "imaging.request",
      entity: "patient",
      entityId: d.patientId,
      detail: { teeth: d.teeth, kind: d.kind, device: d.deviceId, note: d.note || undefined },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, request: row });
}
