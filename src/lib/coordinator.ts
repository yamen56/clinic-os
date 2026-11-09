import type { PoolClient } from "pg";
import { installTemplates } from "./clinic-provision";
import { COORDINATOR_RECIPES } from "./courses";

/**
 * Trigger types the coordinator does the work of. While it is on, any flow
 * of the clinic's on them — the gallery's or its own — would reach the same
 * patient a second time about the same visit, so they are paused, and marked
 * so that switching the coordinator off brings back exactly those.
 */
const REPLACED_TRIGGERS = ["next_visit_due", "treatment_unbooked"];

/**
 * The Admin switch for the treatment coordinator (a test). On: its three
 * flows, installed or switched back on, and the flows it replaces paused. Off:
 * its flows switched off — kept, with their history, for the next time — and
 * the paused ones back.
 */
export async function setCoordinator(c: PoolClient, clinicId: string, on: boolean): Promise<void> {
  const keys = [...COORDINATOR_RECIPES];
  if (on) {
    await c.query(`update automations set active = true where clinic_id = $1 and recipe_key = any($2::text[])`, [clinicId, keys]);
    const missing = await c.query(
      `select * from recipe_templates
        where active and key = any($2::text[])
          and key not in (select recipe_key from automations where clinic_id = $1 and recipe_key is not null)
        order by sort`,
      [clinicId, keys]
    );
    await installTemplates(c, clinicId, missing.rows);
    await c.query(
      `update automations
          set active = false, settings = coalesce(settings, '{}'::jsonb) || '{"paused_by": "coordinator"}'::jsonb
        where clinic_id = $1 and active and trigger_type = any($2::text[])`,
      [clinicId, REPLACED_TRIGGERS]
    );
  } else {
    await c.query(`update automations set active = false where clinic_id = $1 and recipe_key = any($2::text[])`, [clinicId, keys]);
    await c.query(
      `update automations set active = true, settings = settings - 'paused_by'
        where clinic_id = $1 and settings->>'paused_by' = 'coordinator'`,
      [clinicId]
    );
  }
}
