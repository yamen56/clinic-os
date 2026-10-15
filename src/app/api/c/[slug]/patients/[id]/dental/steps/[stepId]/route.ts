import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, STEP_SELECT, toEvent, toMark, toStep } from "@/lib/charts/dental/db";
import { EMERGENCY_STEP, stepOf } from "@/lib/charts/dental/protocols";
import { parseStepData } from "@/lib/charts/dental/step-data";
import { afterStepWithdrawn, carryDetails } from "@/lib/charts/dental/server";

/*
  A step, corrected.

  Its data and note can be put right — a canal re-measured, a length typed
  wrong. A step recorded by mistake is voided with a reason and stays in the
  record; within two minutes, and only for whoever recorded it, it can simply
  be taken back. Either way, a treatment its steps had finished is open again
  when a required step is now missing.
*/

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("void"), eventId: z.string().uuid(), reason: z.string().trim().max(300).optional() }),
  z.object({ op: z.literal("data"), data: z.unknown() }),
  z.object({ op: z.literal("note"), note: z.string().max(2000) }),
]);

type Params = { params: Promise<{ slug: string; id: string; stepId: string }> };

/** The step, its treatment (with a bridge's other teeth), and the lines just written — the shape every answer here takes. */
async function answer(c: import("pg").PoolClient, markId: string) {
  const marks = (
    await c.query(
      `${MARK_SELECT} where m.id = $1
          or (m.group_id is not null and m.group_id = (select group_id from chart_marks where id = $1))`,
      [markId]
    )
  ).rows.map(toMark);
  const steps = (await c.query(`${STEP_SELECT} where s.mark_id = $1 order by s.done_at`, [markId])).rows.map(toStep);
  const events = (
    await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.mark_id = $1 and e.at = now()`, [
      markId,
    ])
  ).rows.map(toEvent);
  return { marks, steps, events };
}

export async function PATCH(req: Request, ctx: Params) {
  const { slug, id, stepId } = await ctx.params;
  if (!isUuid(id) || !isUuid(stepId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const me = access.session.user.id;

  const result = await inClinic(access, async (c) => {
    const s = (
      await c.query(
        `select s.*, m.treatment_key from chart_mark_steps s join chart_marks m on m.id = s.mark_id
          where s.id = $1 and s.patient_id = $2 and s.clinic_id = $3 for update of s`,
        [stepId, id, access.clinicId]
      )
    ).rows[0];
    if (!s) return { error: "not_found" as const };
    if (s.voided_at) return { error: "voided" as const };

    switch (b.op) {
      case "void":
        await c.query(`update chart_mark_steps set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1`, [stepId, me, b.reason || null]);
        await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user, reason) values ($1, $2, $3, 'step_void', $4, $5)`, [
          b.eventId,
          access.clinicId,
          s.mark_id,
          me,
          b.reason,
        ]);
        await afterStepWithdrawn(c, access.clinicId, s.mark_id, me);
        break;
      case "data": {
        const def = s.step === EMERGENCY_STEP ? null : stepOf(s.treatment_key, s.step);
        const data = parseStepData(def, b.data, s.treatment_key);
        if (!data) return { error: "invalid_data" as const };
        await c.query(`update chart_mark_steps set data = $2 where id = $1`, [stepId, JSON.stringify(data)]);
        // A line in the treatment's history: what was recorded was corrected, by whom and when.
        await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'step_edit', $3, $4)`, [
          access.clinicId,
          s.mark_id,
          me,
          s.step,
        ]);
        // The crown's type corrected at its preparation is the crown's, and prices it.
        const m = (await c.query(`select * from chart_marks where id = $1`, [s.mark_id])).rows[0];
        if (m && !m.voided_at) await carryDetails(c, access.clinicId, m, def, data);
        break;
      }
      case "note":
        await c.query(`update chart_mark_steps set note = $2 where id = $1`, [stepId, b.note]);
        break;
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: `dental.step.${b.op}`,
      entity: "patient",
      entityId: id,
      detail: { step: stepId, mark: s.mark_id, name: s.step },
    });
    return answer(c, s.mark_id);
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}

/* Undo: a mis-tap taken back, within two minutes, by whoever recorded it. */
export async function DELETE(_req: Request, ctx: Params) {
  const { slug, id, stepId } = await ctx.params;
  if (!isUuid(id) || !isUuid(stepId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const me = access.session.user.id;

  const result = await inClinic(access, async (c) => {
    const s = (
      await c.query(
        `select mark_id, step from chart_mark_steps
          where id = $1 and patient_id = $2 and clinic_id = $3 and recorded_by = $4
            and voided_at is null and created_at > now() - interval '2 minutes'`,
        [stepId, id, access.clinicId, me]
      )
    ).rows[0];
    if (!s) return { error: "too_late" as const };
    await c.query(`delete from chart_mark_steps where id = $1`, [stepId]);
    /*
      The step's history line cannot go — the entry's history is append-only
      while the entry exists — so a second line says it was taken back. A
      finish the step caused is taken back with it.
    */
    await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'step_void', $3, 'undo')`, [
      access.clinicId,
      s.mark_id,
      me,
    ]);
    await afterStepWithdrawn(c, access.clinicId, s.mark_id, me);
    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.step.undo",
      entity: "patient",
      entityId: id,
      detail: { step: stepId, mark: s.mark_id, name: s.step },
    });
    return answer(c, s.mark_id);
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true, ...result });
}
