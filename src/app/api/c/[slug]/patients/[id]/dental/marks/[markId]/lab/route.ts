import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { toEvent } from "@/lib/charts/dental/db";
import { toLabCase } from "@/lib/charts/dental/labs";

/*
  A treatment's work, sent to a lab.

  The doctor at the chair or the desk sends it: which lab, what it costs — the
  lab's own price for the treatment, changeable — when it is due back, and
  the shade. It is one more case each time: a remake is a second one, the
  first left as it was. A bridge sends once, on its lead; a full arch on the
  arch entry.
*/

const bodySchema = z.object({
  id: z.string().uuid(),
  labId: z.string().uuid(),
  cost: z.number().min(0).max(1_000_000),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  shade: z.string().trim().max(40).default(""),
  note: z.string().trim().max(1000).default(""),
});

type Params = { params: Promise<{ slug: string; id: string; markId: string }> };

export async function POST(req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"], { module: "dental" });
  if (!g.ok) return g.res;
  const access = g.access;
  if (!access.clinic.features.dental) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;
  const cost = Math.round(d.cost * 100) / 100;

  const result = await inClinic(access, async (c) => {
    const mark = (
      await c.query(`select id, kind, status, voided_at, treatment_key from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3`, [
        markId,
        id,
        access.clinicId,
      ])
    ).rows[0];
    if (!mark) return { error: "not_found" as const };
    if (mark.voided_at || mark.kind !== "procedure" || mark.status === "existing") return { error: "not_lab_work" as const };
    const lab = (await c.query(`select name from dental_labs where id = $1 and clinic_id = $2 and active`, [d.labId, access.clinicId])).rows[0];
    if (!lab) return { error: "no_lab" as const };

    const row = (
      await c.query(
        `insert into lab_cases (id, clinic_id, patient_id, mark_id, lab_id, cost, sent_on, due_on, shade, note, created_by)
         values ($1, $2, $3, $4, $5, $6, ((now() at time zone (select timezone from clinics where id = $2)))::date, $7, $8, $9, $10)
         returning *`,
        [d.id, access.clinicId, id, markId, d.labId, cost, d.dueOn, d.shade, d.note, access.session.user.id]
      )
    ).rows[0];
    const ev = (
      await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'lab', $3, $4) returning id`, [
        access.clinicId,
        markId,
        access.session.user.id,
        `sent to ${lab.name} · ${cost}`,
      ])
    ).rows[0];
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "lab_case.send",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, case: row.id, lab: d.labId, cost },
    });
    const event = (await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.id = $1`, [ev.id]))
      .rows[0];
    return { labCase: toLabCase(row), event: toEvent(event) };
  });

  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true, ...result });
}
