import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

/*
  One "Take x-ray" request: the chart asks whether its image has arrived; the
  station says which file answered it, or that it was dismissed. The answering
  file is already in the patient's Files — the station uploads it through the
  ordinary route — and here it is labelled with the teeth the doctor asked for.
*/

type Params = { params: Promise<{ slug: string; reqId: string }> };

export async function GET(_req: Request, ctx: Params) {
  const { slug, reqId } = await ctx.params;
  if (!isUuid(reqId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const row = await inClinic(g.access, async (c) =>
    (
      await c.query(
        `select r.id, r.fulfilled_at, r.cancelled_at, r.teeth,
                f.id as file_id, f.file_name, f.mime_type, f.size_bytes, f.kind as file_kind, f.created_at as file_created_at, f.teeth as file_teeth
           from imaging_requests r left join patient_files f on f.id = r.file_id
          where r.id = $1 and r.clinic_id = $2`,
        [reqId, g.access.clinicId]
      )
    ).rows[0]
  );
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    request: { id: row.id, fulfilledAt: row.fulfilled_at, cancelledAt: row.cancelled_at, teeth: row.teeth },
    file: row.file_id
      ? { id: row.file_id, file_name: row.file_name, mime_type: row.mime_type, size_bytes: row.size_bytes, kind: row.file_kind, created_at: row.file_created_at, teeth: row.file_teeth }
      : null,
  });
}

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("fulfil"), fileId: z.string().uuid() }),
  z.object({ op: z.literal("cancel") }),
]);

export async function POST(req: Request, ctx: Params) {
  const { slug, reqId } = await ctx.params;
  if (!isUuid(reqId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;

  const result = await inClinic(access, async (c) => {
    const r = (
      await c.query(`select * from imaging_requests where id = $1 and clinic_id = $2 for update`, [reqId, access.clinicId])
    ).rows[0];
    if (!r) return { error: "not_found" as const };
    if (r.fulfilled_at || r.cancelled_at) return { error: "closed" as const };
    if (b.op === "cancel") {
      await c.query(`update imaging_requests set cancelled_at = now() where id = $1`, [reqId]);
      return { ok: true as const };
    }
    // The file must be this patient's, in this clinic — the station uploaded it to them a moment ago.
    const f = await c.query(
      `update patient_files set teeth = (select array(select distinct unnest(teeth || $3::text[]) order by 1))
        where id = $1 and clinic_id = $2 and patient_id = $4 returning id`,
      [b.fileId, access.clinicId, r.teeth, r.patient_id]
    );
    if (!f.rowCount) return { error: "wrong_file" as const };
    await c.query(`update imaging_requests set fulfilled_at = now(), file_id = $2 where id = $1`, [reqId, b.fileId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "imaging.fulfil",
      entity: "patient_file",
      entityId: b.fileId,
      detail: { patientId: r.patient_id, request: reqId, teeth: r.teeth },
    });
    return { ok: true as const };
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true });
}
