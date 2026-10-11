import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { CASE_SELECT, toCase } from "@/lib/charts/dental/db";

/*
  Opening a case: one problem and what is done about it.

  The patient's first case takes in the work already planned on the chart
  before cases existed — it is the plan that case is about, and leaving it
  outside would split one plan in two. A later case starts empty: a new
  problem, its own history, diagnosis and plan.
*/

const bodySchema = z.object({
  id: z.string().uuid(),
  complaint: z.string().trim().max(2000).default(""),
  title: z.string().trim().max(120).default(""),
  doctorMemberId: z.string().uuid().nullish(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const me = access.session.user.id;

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" as const };
    if (b.doctorMemberId) {
      const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [b.doctorMemberId, access.clinicId]);
      if (!ok.rowCount) return { error: "invalid_doctor" as const };
    }
    const first = !(await c.query(`select 1 from treatment_cases where patient_id = $1 and clinic_id = $2 limit 1`, [id, access.clinicId])).rowCount;
    await c.query(
      `insert into treatment_cases (id, clinic_id, patient_id, title, complaint, doctor_member_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [b.id, access.clinicId, id, b.title, b.complaint, b.doctorMemberId ?? null, me]
    );
    const adopted = first
      ? (
          await c.query(
            `update chart_marks set case_id = $1
              where patient_id = $2 and clinic_id = $3 and case_id is null and voided_at is null
                and kind = 'procedure' and status = 'planned'
            returning id`,
            [b.id, id, access.clinicId]
          )
        ).rows.map((r) => r.id as string)
      : [];
    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.case.create",
      entity: "patient",
      entityId: id,
      detail: { case: b.id, adopted: adopted.length },
    });
    const row = (await c.query(`${CASE_SELECT} where tc.id = $1`, [b.id])).rows[0];
    return { case: toCase(row), adopted };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true, ...result });
}
