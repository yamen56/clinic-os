import type { PoolClient } from "pg";
import { resolveFeatures, toFeatureSetting, type FeatureMap } from "./features";
import { PLAN_PROFILES, applyPlan, type Plan } from "./plans";

/**
 * Moving a clinic to another plan, and what follows from it.
 *
 * Server-only, and the one place a plan becomes a licence: the plan's preset is
 * written over the plan modules in `clinics.features`, the member limit is set,
 * and what the new licence can no longer run is paused rather than left to fail.
 * Nothing is deleted — a clinic that upgrades again finds its work where it was.
 */

export type PlanChangeResult = {
  /** Flows switched off because they were built by hand and the plan no longer builds flows. */
  paused: string[];
  /** Active members now, against the plan's limit — over it, nobody new can be added until someone leaves. */
  members: number;
  memberLimit: number | null;
};

/**
 * Switches off every active flow the clinic built itself (no `recipe_key`).
 * Gallery copies keep running: editing their words and timing is what the
 * basic plan still does. Returns the names, for the agency to read back.
 */
export async function pauseBuiltFlows(c: PoolClient, clinicId: string): Promise<string[]> {
  const r = await c.query(
    `update automations set active = false, updated_at = now()
      where clinic_id = $1 and active and recipe_key is null
      returning name`,
    [clinicId]
  );
  return r.rows.map((x) => x.name as string);
}

export async function activeMembers(c: PoolClient, clinicId: string): Promise<number> {
  const r = await c.query(`select count(*)::int as n from clinic_members where clinic_id = $1 and active`, [clinicId]);
  return r.rows[0].n as number;
}

/** What the plan change leaves running, given the licence before and after. */
async function settle(c: PoolClient, clinicId: string, before: FeatureMap, after: FeatureMap): Promise<string[]> {
  if (before.automations_advanced && !after.automations_advanced) return pauseBuiltFlows(c, clinicId);
  return [];
}

/**
 * Puts a clinic on a plan. `memberLimit` overrides the plan's own (the agency
 * selling a Doctor plan with a third seat); omitted, the plan's limit applies.
 * Must run inside the caller's transaction.
 */
export async function setClinicPlan(
  c: PoolClient,
  clinicId: string,
  plan: Plan,
  opts: { memberLimit?: number | null } = {}
): Promise<PlanChangeResult | null> {
  const row = (
    await c.query(`select features from clinics where id = $1 and deleted_at is null for update`, [clinicId])
  ).rows[0];
  if (!row) return null;
  const before = resolveFeatures(row.features);
  const after = applyPlan(before, plan);
  const memberLimit = opts.memberLimit !== undefined ? opts.memberLimit : PLAN_PROFILES[plan].memberLimit;
  await c.query(
    `update clinics set plan = $2, features = $3::jsonb, member_limit = $4, updated_at = now() where id = $1`,
    [clinicId, plan, JSON.stringify(toFeatureSetting(after)), memberLimit]
  );
  const paused = await settle(c, clinicId, before, after);
  return { paused, members: await activeMembers(c, clinicId), memberLimit };
}

/** The same consequences for a hand-made module change (the admin's Adjust modules). */
export async function settleFeatureChange(c: PoolClient, clinicId: string, before: FeatureMap, after: FeatureMap): Promise<string[]> {
  return settle(c, clinicId, before, after);
}

/** Room for one more active member? Read by the staff screen before it invites. */
export async function seatState(c: PoolClient, clinicId: string): Promise<{ used: number; limit: number | null; full: boolean }> {
  const r = (
    await c.query(
      `select cl.member_limit as limit,
              (select count(*)::int from clinic_members m where m.clinic_id = cl.id and m.active) as used
         from clinics cl where cl.id = $1`,
      [clinicId]
    )
  ).rows[0];
  const limit = (r?.limit as number | null) ?? null;
  const used = (r?.used as number) ?? 0;
  return { used, limit, full: limit !== null && used >= limit };
}

/** True when a Postgres error is the member-limit trigger's. */
export function isMemberLimitError(e: unknown): boolean {
  return (e as { message?: string })?.message === "member_limit";
}
