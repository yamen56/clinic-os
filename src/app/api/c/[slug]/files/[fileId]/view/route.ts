import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { FILE_VIEWS, kindOfView } from "@/lib/imaging/kinds";

/*
  What a picture shows — panoramic, bitewing, periapical, occlusal, CBCT, an
  intraoral photo (Yamen, 2026-11-02) — set from the viewer, beside the teeth
  it is of. A label on the file, like its teeth; the file itself is untouched.
  The view says the kind too, so a "photo" that is a bitewing files as an
  x-ray. Null takes the label off and leaves the kind.
*/

const bodySchema = z.object({ view: z.enum(FILE_VIEWS).nullable() });

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await ctx.params;
  if (!isUuid(fileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const view = parsed.data.view;

  const row = await inClinic(access, async (c) => {
    const r = await c.query(
      `update patient_files set view = $3, kind = coalesce($4, kind)
        where id = $1 and clinic_id = $2 and kind <> 'insurance_card'
        returning id, patient_id, view, kind`,
      [fileId, access.clinicId, view, view ? kindOfView(view) : null]
    );
    if (!r.rowCount) return null;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.file.view",
      entity: "patient_file",
      entityId: fileId,
      detail: { patientId: r.rows[0].patient_id, view },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, view: row.view, kind: row.kind });
}
