/**
 * What the chart's routes share on the server: which visit a piece of work
 * belongs to, how a group's members follow it, and when a treatment's steps
 * make it finished — or no longer finished.
 */

import type { PoolClient } from "pg";
import { leadIdOf } from "./full-arch";
import { EMERGENCY_STEP, protocolFor, type StepDef } from "./protocols";

/**
 * Today's visit for this patient, which work done now belongs to.
 *
 * Today in the clinic's own timezone, not cancelled and not a no-show. With
 * more than one, the visit this item was booked into comes first, then the
 * doctor's own, then the one nearest now. A walk-in has none, and its work
 * counts by the day instead.
 */
export async function todaysVisit(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  markId: string | null,
  performerId: string | null
): Promise<string | null> {
  const r = await c.query(
    `select a.id
       from appointments a
       join clinics cl on cl.id = a.clinic_id
      where a.clinic_id = $1 and a.patient_id = $2
        and a.status not in ('cancelled', 'no_show')
        and (a.starts_at at time zone cl.timezone)::date = (now() at time zone cl.timezone)::date
      order by (exists (select 1 from appointment_items ai where ai.appointment_id = a.id and ai.mark_id = $3::uuid)) desc,
               (a.doctor_member_id = $4::uuid) desc nulls last,
               abs(extract(epoch from (a.starts_at - now())))
      limit 1`,
    [clinicId, patientId, markId, performerId]
  );
  return (r.rows[0]?.id as string) ?? null;
}

type Row = { id: string; site: string; group_id: string | null; treatment_key: string; status: string; look: string; role: string | null };

/**
 * The other members of the group a mark leads — a full arch's teeth, a
 * bridge's other teeth — or none, when the mark is not a group's lead.
 */
export async function followersOf(c: PoolClient, clinicId: string, m: Row): Promise<Row[]> {
  if (!m.group_id) return [];
  const all = (
    await c.query(`select id, site, group_id, treatment_key, status, look, role from chart_marks where group_id = $1 and clinic_id = $2`, [m.group_id, clinicId])
  ).rows as Row[];
  return leadIdOf(all) === m.id ? all.filter((x) => x.id !== m.id) : [];
}

/**
 * Mark members done or voided, each with its own line in its tooth's history.
 * Returns the ids it changed.
 */
export async function applyToMembers(
  c: PoolClient,
  clinicId: string,
  ids: string[],
  op: "done" | "void",
  by: string,
  reason: string | null,
  visit: string | null = null
): Promise<string[]> {
  if (!ids.length) return [];
  const r =
    op === "done"
      ? await c.query(
          `update chart_marks set status = 'done', done_at = now(), appointment_id = coalesce(appointment_id, $2)
            where id = any($1::uuid[]) and status = 'planned' and voided_at is null returning id`,
          [ids, visit]
        )
      : await c.query(
          `update chart_marks set voided_at = now(), voided_by = $2, void_reason = $3
            where id = any($1::uuid[]) and voided_at is null returning id`,
          [ids, by, reason]
        );
  const changed = r.rows.map((x) => x.id as string);
  if (changed.length) {
    await c.query(
      `insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason)
       select $1, k, $3, $4, $5 from unnest($2::uuid[]) as k`,
      [clinicId, changed, op, by, op === "void" ? reason : null]
    );
  }
  return changed;
}

/** Which of a full arch's teeth a step finishes: its implants, its extractions, its bridge. */
function finishedBy(def: StepDef, followers: Row[]): string[] {
  const out: string[] = [];
  for (const f of def.finishes ?? []) {
    for (const x of followers) {
      if (x.status !== "planned") continue;
      if (f === "implants" && x.look === "implant") out.push(x.id);
      if (f === "extractions" && x.look === "extraction") out.push(x.id);
      if (f === "bridge" && x.role === "pontic") out.push(x.id);
    }
  }
  return out;
}

/** The required steps of a treatment still to be recorded. */
export async function missingSteps(c: PoolClient, markId: string, treatmentKey: string): Promise<string[]> {
  const steps = protocolFor(treatmentKey);
  if (!steps) return [];
  const done = new Set(
    (await c.query(`select distinct step from chart_mark_steps where mark_id = $1 and voided_at is null and step <> $2`, [markId, EMERGENCY_STEP])).rows.map(
      (r) => r.step as string
    )
  );
  return steps.filter((s) => !s.optional && !done.has(s.key)).map((s) => s.key);
}

/**
 * After a step is recorded: the teeth of a full arch it finishes, and — when
 * it was the last required step — the treatment itself, with every member of
 * its group. Returns the ids of every member it changed besides the mark.
 */
export async function afterStep(
  c: PoolClient,
  clinicId: string,
  m: Row,
  def: StepDef | null,
  by: string,
  visit: string | null
): Promise<{ completed: boolean; changed: string[] }> {
  if (!def || m.status !== "planned") return { completed: false, changed: [] };
  const followers = await followersOf(c, clinicId, m);
  const changed = await applyToMembers(c, clinicId, finishedBy(def, followers), "done", by, null, visit);
  if ((await missingSteps(c, m.id, m.treatment_key)).length) return { completed: false, changed };
  await c.query(`update chart_marks set status = 'done', done_at = now(), appointment_id = coalesce(appointment_id, $2) where id = $1`, [m.id, visit]);
  // "steps": finished by its own steps, so a step taken back can take the finish back too.
  await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'done', $3, 'steps')`, [clinicId, m.id, by]);
  const rest = await applyToMembers(
    c,
    clinicId,
    followers.filter((x) => !changed.includes(x.id)).map((x) => x.id),
    "done",
    by,
    null,
    visit
  );
  return { completed: true, changed: [...changed, ...rest] };
}

/**
 * After a step is taken back: a treatment its steps had finished is open
 * again when a required step is now missing. One finished by hand ("Finish
 * now") stays finished — that was a decision, not arithmetic.
 */
export async function afterStepWithdrawn(c: PoolClient, clinicId: string, markId: string, by: string): Promise<boolean> {
  const m = (await c.query(`select id, treatment_key, status from chart_marks where id = $1 and clinic_id = $2`, [markId, clinicId])).rows[0];
  if (!m || m.status !== "done") return false;
  const last = (
    await c.query(`select reason from chart_mark_events where mark_id = $1 and action = 'done' order by at desc limit 1`, [markId])
  ).rows[0];
  if (last?.reason !== "steps") return false;
  if (!(await missingSteps(c, markId, m.treatment_key)).length) return false;
  await c.query(`update chart_marks set status = 'planned', done_at = null where id = $1`, [markId]);
  await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user) values ($1, $2, 'reopened', $3)`, [clinicId, markId, by]);
  return true;
}
