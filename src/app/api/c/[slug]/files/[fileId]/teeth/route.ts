import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

/*
  Which teeth an x-ray or a photo is of. Set from the dental chart's viewer or
  a tooth's panel, so the radiograph of 36 opens from 36. The file itself is
  untouched; this is a label on it, and the Files tab still lists it as before.
*/

const bodySchema = z.object({ teeth: z.array(z.string().regex(/^[1-8][1-8]$/)).max(32) });

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await ctx.params;
  if (!isUuid(fileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const teeth = [...new Set(parsed.data.teeth)].sort();

  const row = await inClinic(access, async (c) => {
    const r = await c.query(
      `update patient_files set teeth = $3 where id = $1 and clinic_id = $2 and kind <> 'insurance_card'
       returning id, patient_id, teeth`,
      [fileId, access.clinicId, teeth]
    );
    if (!r.rowCount) return null;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.file.teeth",
      entity: "patient_file",
      entityId: fileId,
      detail: { patientId: r.rows[0].patient_id, teeth },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, teeth: row.teeth });
}
