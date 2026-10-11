import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, STEP_SELECT, toEvent, toMark, toStep } from "@/lib/charts/dental/db";
import { EMERGENCY_STEP, stepOf } from "@/lib/charts/dental/protocols";
import { parseStepData } from "@/lib/charts/dental/step-data";
import { afterStep, todaysVisit } from "@/lib/charts/dental/server";

/*
  A step of a treatment, done: the access cavity, the working length of each
  canal, the obturation, an implant placed — or an emergency visit in the
  middle of it, which counts as a visit but moves nothing on.

  The browser chooses the ids, as it does for entries, so the step it drew and
  the step stored are the same row. The step and what it carries are checked
  against the treatment's own steps here, never trusted from the request; the
  visit it belongs to is today's, found here too.

  When it was the last required step, the treatment is finished in the same
  transaction — and every tooth of its group with it.
*/

const bodySchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  step: z.string().min(1).max(40),
  data: z.unknown().optional(),
  note: z.string().max(2000).default(""),
  performedBy: z.string().uuid().nullish(),
});

type Params = { params: Promise<{ slug: string; id: string; markId: string }> };

export async function POST(req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const me = access.session.user.id;

  const result = await inClinic(access, async (c) => {
    const m = (
      await c.query(`select * from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3 for update`, [markId, id, access.clinicId])
    ).rows[0];
    if (!m) return { error: "not_found" as const };
    if (m.voided_at) return { error: "voided" as const };
    if (m.status === "existing") return { error: "not_ours" as const };

    const emergency = b.step === EMERGENCY_STEP;
    const def = emergency ? null : stepOf(m.treatment_key, b.step);
    if (!emergency && !def) return { error: "unknown_step" as const };
    if (def && !def.repeatable) {
      const again = await c.query(`select 1 from chart_mark_steps where mark_id = $1 and step = $2 and voided_at is null`, [markId, b.step]);
      if (again.rowCount) return { error: "already_done" as const };
    }
    const data = parseStepData(def, b.data);
    if (!data) return { error: "invalid_data" as const };

    // A foreign key does not see row security: the doctor is checked against this clinic by hand.
    const performer = b.performedBy ?? null;
    if (performer) {
      const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [performer, access.clinicId]);
      if (!ok.rowCount) return { error: "invalid_performer" as const };
    }

    const visit = await todaysVisit(c, access.clinicId, id, markId, performer);
    await c.query(
      `insert into chart_mark_steps (id, clinic_id, mark_id, patient_id, step, data, note, performed_by, recorded_by, appointment_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [b.id, access.clinicId, markId, id, b.step, JSON.stringify(data), b.note, performer, me, visit]
    );
    // The history line names the step, so the tooth's timeline reads "Working length — 10 Oct".
    await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user, reason) values ($1, $2, $3, 'step', $4, $5)`, [
      b.eventId,
      access.clinicId,
      markId,
      me,
      b.step,
    ]);

    const { completed, changed } = emergency ? { completed: false, changed: [] as string[] } : await afterStep(c, access.clinicId, m, def, me, visit);

    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.step.create",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, site: m.site, treatment: m.treatment_key, step: b.step, completed },
    });

    const ids = [markId, ...changed];
    const marks = (await c.query(`${MARK_SELECT} where m.id = any($1::uuid[])`, [ids])).rows.map(toMark);
    const steps = (await c.query(`${STEP_SELECT} where s.mark_id = $1 order by s.done_at`, [markId])).rows.map(toStep);
    // Every line this transaction wrote, on the treatment and on the teeth it finished.
    const events = (
      await c.query(
        `select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user
          where e.mark_id = any($1::uuid[]) and e.at = now()`,
        [ids]
      )
    ).rows.map(toEvent);
    return { marks, steps, events, completed };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}
