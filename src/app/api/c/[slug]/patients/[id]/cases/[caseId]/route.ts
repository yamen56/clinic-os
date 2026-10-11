import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { CASE_SELECT, toCase } from "@/lib/charts/dental/db";

/*
  A case, saved as it is typed: the autosave endpoint, the same shape as the
  patient file's. A field that cannot be saved is refused on its own and the
  rest of the patch still lands.

  Closing a case is a field too, and so is "the medical history was looked at
  again for this case" — stamped with who and when.
*/

const TEXT: Record<string, number> = { title: 120, complaint: 2000, history: 8000, exam: 8000, diagnosis: 4000 };

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string; caseId: string }> }) {
  const { slug, id, caseId } = await ctx.params;
  if (!isUuid(id) || !isUuid(caseId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const me = access.session.user.id;
  const body = (await req.json().catch(() => null)) as { patch?: Record<string, unknown> } | null;
  const patch = body?.patch;
  if (!patch || typeof patch !== "object") return NextResponse.json({ error: "bad_json" }, { status: 400 });

  return inClinic(access, async (c) => {
    const cur = (
      await c.query(`select * from treatment_cases where id = $1 and patient_id = $2 and clinic_id = $3 for update`, [caseId, id, access.clinicId])
    ).rows[0];
    if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const sets: string[] = [];
    const vals: unknown[] = [caseId];
    const rejected: Record<string, { error: string }> = {};
    const push = (sql: string, ...v: unknown[]) => {
      let s = sql;
      for (const x of v) {
        vals.push(x);
        s = s.replace("?", `$${vals.length}`);
      }
      sets.push(s);
    };

    for (const [key, raw] of Object.entries(patch)) {
      if (key in TEXT) {
        if (typeof raw !== "string" || raw.length > TEXT[key]) rejected[key] = { error: "invalid" };
        else push(`${key} = ?`, raw);
      } else if (key === "doctor_member_id") {
        if (raw === null) push("doctor_member_id = null");
        else if (typeof raw === "string" && isUuid(raw)) {
          const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [raw, access.clinicId]);
          if (ok.rowCount) push("doctor_member_id = ?", raw);
          else rejected[key] = { error: "invalid_doctor" };
        } else rejected[key] = { error: "invalid" };
      } else if (key === "status") {
        if (raw === "closed") push("status = 'closed', closed_at = now(), closed_by = ?", me);
        else if (raw === "open") push("status = 'open', closed_at = null, closed_by = null");
        else rejected[key] = { error: "invalid" };
      } else if (key === "medical_reviewed") {
        if (raw === true) push("medical_reviewed_at = now(), medical_reviewed_by = ?", me);
        else rejected[key] = { error: "invalid" };
      } else {
        rejected[key] = { error: "unknown_field" };
      }
    }

    if (sets.length) {
      await c.query(`update treatment_cases set ${sets.join(", ")} where id = $1`, vals);
      await audit(c, {
        clinicId: access.clinicId,
        userId: me,
        impersonatedBy: access.session.impersonatedBy,
        action: "dental.case.update",
        entity: "patient",
        entityId: id,
        detail: { case: caseId, fields: Object.keys(patch).filter((k) => !(k in rejected)) },
      });
    }
    const row = (await c.query(`${CASE_SELECT} where tc.id = $1`, [caseId])).rows[0];
    return NextResponse.json({ ok: true, case: toCase(row), rejected });
  });
}
