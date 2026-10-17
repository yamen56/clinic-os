import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { normalizeSettings, normalizeStepConfig, normalizeTriggerConfig, type FlowSettings } from "./catalog";
import { legacyTreeEdges, type FlowEdge, type FlowNode } from "./graph";

/**
 * Reading and writing a flow as the canvas holds it.
 *
 * Steps keep their ids from one save to the next — that is the whole point.
 * The old save deleted every step and wrote the tree out again, so each
 * waiting run lost its place (its step id pointed at a deleted row) and began
 * again at the top: the welcome sent twice, the tag added twice, the task
 * created twice, because somebody corrected a word in step four.
 */

export type StoredFlow = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  triggerConfig: Record<string, unknown>;
  settings: FlowSettings;
  canvas: { trigger?: { x: number; y: number } | null };
  active: boolean;
  updatedAt: string;
  recipeKey: string | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export async function loadFlow(c: PoolClient, clinicId: string, id: string): Promise<StoredFlow | null> {
  const a = (
    await c.query(`select * from automations where id = $1 and clinic_id = $2`, [id, clinicId])
  ).rows[0];
  if (!a) return null;
  const steps = (
    await c.query(
      `select id, step_type, config, position, label, parent_step_id, branch, sort from automation_steps
        where automation_id = $1 order by sort, created_at`,
      [id]
    )
  ).rows;
  let edges = (
    await c.query(`select from_step_id, handle, to_step_id from automation_edges where automation_id = $1`, [id])
  ).rows;
  if (!edges.length && steps.length && !("trigger" in (a.canvas ?? {}))) {
    edges = legacyTreeEdges(steps).map((e) => ({ from_step_id: e.from, handle: e.handle, to_step_id: e.to }));
  }
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? "",
    trigger: a.trigger_type,
    triggerConfig: normalizeTriggerConfig(a.trigger_type, a.trigger_config),
    settings: normalizeSettings(a.settings),
    canvas: a.canvas ?? {},
    active: a.active,
    updatedAt: new Date(a.updated_at).toISOString(),
    recipeKey: a.recipe_key ?? null,
    nodes: steps.map((s) => ({
      id: s.id,
      type: s.step_type,
      config: normalizeStepConfig(s.step_type, s.config),
      position: s.position && Number.isFinite(s.position.x) && Number.isFinite(s.position.y) ? s.position : null,
      label: s.label ?? "",
    })),
    edges: edges.map((e) => ({ from: e.from_step_id, handle: e.handle, to: e.to_step_id })),
  };
}

/**
 * Writes the steps and edges of one automation, which must already exist.
 *
 * Steps are upserted by id. A step no longer in the flow is deleted, and any
 * run standing on it is cancelled first and says why — otherwise the foreign
 * key would quietly null its position and the run would start again from the
 * trigger. Edges are replaced wholesale; they carry no state of their own.
 */
export async function writeFlowGraph(
  c: PoolClient,
  clinicId: string,
  automationId: string,
  nodes: FlowNode[],
  edges: FlowEdge[]
): Promise<{ cancelledRuns: number }> {
  const existing = new Set<string>(
    (await c.query(`select id from automation_steps where automation_id = $1`, [automationId])).rows.map((r) => r.id)
  );
  const keep = new Set(nodes.map((n) => n.id));
  const removed = [...existing].filter((id) => !keep.has(id));

  let cancelledRuns = 0;
  if (removed.length) {
    const cancelled = await c.query(
      `update automation_runs set status = 'cancelled', finished_at = now(), wake_at = null, error = 'step_removed'
        where automation_id = $1 and status in ('running', 'waiting') and current_step_id = any($2::uuid[])
        returning id, current_step_id`,
      [automationId, removed]
    );
    cancelledRuns = cancelled.rowCount ?? 0;
    for (const r of cancelled.rows) {
      await c.query(
        `insert into automation_run_logs (clinic_id, run_id, step_id, status, detail)
         values ($1, $2, null, 'cancelled', '{"reason":"step_removed"}')`,
        [clinicId, r.id]
      );
    }
    await c.query(`delete from automation_steps where automation_id = $1 and id = any($2::uuid[])`, [
      automationId,
      removed,
    ]);
  }

  let sort = 0;
  for (const n of nodes) {
    const values = [
      n.id,
      clinicId,
      automationId,
      sort++,
      n.type,
      JSON.stringify(n.config ?? {}),
      n.position ? JSON.stringify({ x: Math.round(n.position.x), y: Math.round(n.position.y) }) : null,
      (n.label ?? "").slice(0, 80),
    ];
    if (existing.has(n.id)) {
      await c.query(
        `update automation_steps set sort = $4, step_type = $5, config = $6, position = $7, label = $8,
                parent_step_id = null, branch = null
          where id = $1 and clinic_id = $2 and automation_id = $3`,
        values
      );
    } else {
      await c.query(
        `insert into automation_steps (id, clinic_id, automation_id, sort, step_type, config, position, label)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        values
      );
    }
  }

  await c.query(`delete from automation_edges where automation_id = $1`, [automationId]);
  for (const e of edges) {
    await c.query(
      `insert into automation_edges (clinic_id, automation_id, from_step_id, handle, to_step_id)
       values ($1, $2, $3, $4, $5)`,
      [clinicId, automationId, e.from, e.handle, e.to]
    );
  }
  return { cancelledRuns };
}

/** The same flow under fresh ids, for a copy. */
export function reissueIds(nodes: FlowNode[], edges: FlowEdge[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const map = new Map(nodes.map((n) => [n.id, randomUUID()]));
  return {
    nodes: nodes.map((n) => ({ ...n, id: map.get(n.id)! })),
    edges: edges
      .filter((e) => (e.from === null || map.has(e.from)) && map.has(e.to))
      .map((e) => ({ from: e.from === null ? null : map.get(e.from)!, handle: e.handle, to: map.get(e.to)! })),
  };
}

/* -------------------------------------------------------------------------
   History
   ------------------------------------------------------------------------- */

export type RunRow = {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  patient_id: string | null;
  patient_name: string | null;
  current_step_id: string | null;
  wake_at: string | null;
  test: boolean;
  logs: { status: string; detail: Record<string, unknown>; at: string; step_id: string | null; step: string | null }[];
};

export const RUNS_PAGE = 40;

export async function queryRuns(
  c: PoolClient,
  clinicId: string,
  automationId: string,
  status: string | null,
  before: string | null
): Promise<RunRow[]> {
  const r = await c.query(
    `select r.id, r.status, r.started_at, r.finished_at, r.error, r.patient_id, p.full_name as patient_name,
            r.current_step_id, r.wake_at, coalesce(r.context->>'test', 'false') = 'true' as test,
            coalesce((select json_agg(json_build_object('status', l.status, 'detail', l.detail, 'at', l.created_at,
                                                        'step_id', l.step_id, 'step', s.step_type) order by l.created_at)
                        from automation_run_logs l left join automation_steps s on s.id = l.step_id
                       where l.run_id = r.id), '[]') as logs
       from automation_runs r
       left join patients p on p.id = r.patient_id
      where r.automation_id = $1 and r.clinic_id = $2
        and ($3::text is null or r.status = $3)
        and ($4::timestamptz is null or r.started_at < $4)
      order by r.started_at desc
      limit ${RUNS_PAGE}`,
    [automationId, clinicId, status, before]
  );
  return JSON.parse(JSON.stringify(r.rows));
}
