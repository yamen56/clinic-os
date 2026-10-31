import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

/*
  Forget what the machine's name for a patient means (imaging_patient_links):
  learned from a picture filed to the wrong person, or a folder that turned
  out to hold more than one. The machine's next picture under that name waits
  in the inbox again, and filing it teaches the link afresh.
*/
export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string; linkId: string }> }) {
  const { slug, linkId } = await ctx.params;
  if (!isUuid(linkId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;
  const gone = await inClinic(access, async (c) => {
    const r = await c.query(`delete from imaging_patient_links where id = $1 and clinic_id = $2 returning patient_id, key, label`, [
      linkId,
      access.clinicId,
    ]);
    if (!r.rowCount) return null;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "imaging.link.forget",
      entity: "patient",
      entityId: r.rows[0].patient_id,
      detail: { key: r.rows[0].key, label: r.rows[0].label },
    });
    return r.rows[0];
  });
  if (!gone) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
