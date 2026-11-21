import type { PoolClient } from "pg";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { can, type ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";
import { isStepKey, isTriggerKey, normalizeSettings, normalizeStepConfig, parseStepConfig, parseTriggerConfig } from "./catalog";
import { blocking, validateFlow, type FlowEdge, type FlowNode, type Issue } from "./graph";
import { writeFlowGraph } from "./store";

/*
  Saving a flow, for the builder's autosave (the route beside the builder) and
  for its Done button and first save (the server action). One place, so the
  two can never accept different flows.
*/

const uuid = z.string().refine(isUuid, "uuid");
const position = z.object({ x: z.number().finite(), y: z.number().finite() });

/*
  Every output a step can have, as the database's own check spells them
  (automation_edges_handle_check). This was `max(12)`, and "already_booked"
  is fourteen letters: every flow with a booking step in it — each "reply 1
  to book" template, which are also the longest — was refused on save with
  nothing to say why.
*/
const HANDLE = /^(next|yes|no|replied|timeout|other|booked|already_booked|no_slot|opt:[0-9]{1,2})$/;

export const saveSchema = z.object({
  id: uuid.optional(),
  /** When the editor loaded the flow; a save over somebody else's newer one is refused. */
  baseUpdatedAt: z.string().nullable().optional(),
  /**
   * One open editor. Its own saves move `updated_at` on, so a later save from
   * the same screen is not mistaken for a stale one; another screen's is.
   */
  session: z.string().max(64).optional(),
  /** The template it was made from, on the first save only. */
  recipeKey: z.string().max(80).optional(),
  name: z.string().trim().min(1).max(80),
  // Template descriptions run past 300 characters (the coordinator's do).
  description: z.string().max(1000).default(""),
  trigger: z.string().refine(isTriggerKey, "trigger"),
  triggerConfig: z.record(z.string(), z.unknown()).default({}),
  settings: z.unknown().optional(),
  canvas: z.object({ trigger: position.nullable().optional() }).default({}),
  nodes: z
    .array(
      z.object({
        id: uuid,
        type: z.string().refine(isStepKey, "step"),
        config: z.record(z.string(), z.unknown()).default({}),
        position: position.nullable().default(null),
        label: z.string().max(80).default(""),
      })
    )
    .max(200),
  edges: z.array(z.object({ from: uuid.nullable(), handle: z.string().regex(HANDLE), to: uuid })).max(800),
  active: z.boolean().default(false),
});

export type SaveFlowInput = z.input<typeof saveSchema>;

export type SaveError =
  | "forbidden"
  | "invalid"
  | "invalid_flow"
  | "not_found"
  | "conflict"
  | "bad_media"
  | "bad_target";

export type SaveFlowResult = {
  id?: string;
  updatedAt?: string;
  error?: SaveError;
  /** The step whose settings could not be read, so the builder can open it. */
  nodeId?: string;
  issues?: Issue[];
  /** Runs stopped because the step they were waiting on was removed. */
  cancelledRuns?: number;
};

/**
 * A file attached to a message must be one this clinic uploaded through the
 * automations upload route, and its kind is read off the name that route gave
 * it — never taken from the browser.
 */
function checkMedia(clinicId: string, nodes: FlowNode[]): boolean {
  for (const n of nodes) {
    if (n.type !== "send_whatsapp" || !n.config.media) continue;
    const m = n.config.media as { path: string; kind: string; name: string; mime: string };
    const match = m.path.match(new RegExp(`^${clinicId}/automation-media/[0-9a-f]{8}-([^/\\\\]+\\.(jpg|pdf))$`));
    if (!match) return false;
    const pdf = match[2] === "pdf";
    n.config.media = { path: m.path, kind: pdf ? "document" : "image", name: m.name || match[1], mime: pdf ? "application/pdf" : "image/jpeg" };
  }
  return true;
}

async function checkTargets(c: PoolClient, clinicId: string, selfId: string | undefined, nodes: FlowNode[]): Promise<boolean> {
  const targets = nodes
    .filter((n) => n.type === "goto_automation" && String(n.config.automation_id ?? ""))
    .map((n) => String(n.config.automation_id));
  if (!targets.length) return true;
  if (targets.some((t) => !isUuid(t) || t === selfId)) return false;
  const r = await c.query(`select count(*)::int as n from automations where clinic_id = $1 and id = any($2::uuid[])`, [
    clinicId,
    [...new Set(targets)],
  ]);
  return r.rows[0].n === new Set(targets).size;
}

export async function saveFlow(access: ClinicAccess, slug: string, data: unknown): Promise<SaveFlowResult> {
  if (!can(access, "automations")) return { error: "forbidden" };
  const parsed = saveSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  const triggerConfig = parseTriggerConfig(d.trigger, d.triggerConfig);
  if (!triggerConfig.success) return { error: "invalid", nodeId: "trigger" };
  const nodes: FlowNode[] = [];
  for (const n of d.nodes) {
    const cfg = parseStepConfig(n.type, normalizeStepConfig(n.type, n.config));
    // Named, so the builder can open the one step that is wrong instead of a blank "could not save".
    if (!cfg.success) return { error: "invalid", nodeId: n.id };
    nodes.push({ id: n.id, type: n.type, config: cfg.data as Record<string, unknown>, position: n.position, label: n.label });
  }
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) return { error: "invalid" };
  const edges: FlowEdge[] = d.edges;
  const settings = normalizeSettings(d.settings);
  if (!checkMedia(access.clinicId, nodes)) return { error: "bad_media" };

  const issues = validateFlow({
    trigger: d.trigger,
    triggerConfig: triggerConfig.data as Record<string, unknown>,
    nodes,
    edges,
    settings,
  });
  // Malformed wiring is never stored, whether or not the flow is switched on.
  if (issues.some((i) => i.code === "bad_edge")) return { error: "invalid_flow", issues };
  // A flow that is on is never replaced by one that cannot run.
  if (d.active && blocking(issues)) return { error: "invalid_flow", issues };

  const result = await inClinic(access, async (c): Promise<SaveFlowResult> => {
    if (!(await checkTargets(c, access.clinicId, d.id, nodes))) return { error: "bad_target" };

    // A step id already used by another flow is not this flow's to overwrite.
    const foreign = await c.query(
      `select 1 from automation_steps where id = any($1::uuid[]) and (automation_id <> $2::uuid or clinic_id <> $3) limit 1`,
      [nodes.map((n) => n.id), d.id ?? "00000000-0000-0000-0000-000000000000", access.clinicId]
    );
    if (foreign.rowCount) return { error: "invalid" };

    const canvas = JSON.stringify({ trigger: d.canvas.trigger ?? null, ...(d.session ? { session: d.session } : {}) });
    const values = [d.name, d.description, d.trigger, JSON.stringify(triggerConfig.data), d.active, JSON.stringify(settings), canvas];
    let id = d.id;
    // One line in the audit log per sitting at the builder, not one per autosave.
    let auditIt = !d.id;
    if (id) {
      const cur = (
        await c.query(`select updated_at, active, canvas->>'session' as session from automations where id = $1 and clinic_id = $2 for update`, [
          id,
          access.clinicId,
        ])
      ).rows[0];
      if (!cur) return { error: "not_found" };
      const moved = d.baseUpdatedAt && new Date(cur.updated_at).getTime() !== new Date(d.baseUpdatedAt).getTime();
      if (moved && !(d.session && cur.session === d.session)) return { error: "conflict" };
      auditIt = cur.active !== d.active || !d.session || cur.session !== d.session;
      await c.query(
        `update automations set name = $3, description = $4, trigger_type = $5, trigger_config = $6, active = $7,
                settings = $8, canvas = $9
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, ...values]
      );
    } else {
      const r = await c.query(
        `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, settings, canvas, recipe_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [access.clinicId, ...values, d.recipeKey || null]
      );
      id = r.rows[0].id as string;
    }
    const { cancelledRuns } = await writeFlowGraph(c, access.clinicId, id!, nodes, edges);
    const updatedAt = new Date(
      (await c.query(`select updated_at from automations where id = $1`, [id])).rows[0].updated_at
    ).toISOString();
    if (auditIt || cancelledRuns) {
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: d.id ? "automation.update" : "automation.create",
        entity: "automation",
        entityId: id!,
        detail: { name: d.name, active: d.active, steps: nodes.length, cancelledRuns },
      });
    }
    return { id, updatedAt, issues, cancelledRuns };
  });
  if (result.id) revalidatePath(`/c/${slug}/automations`);
  return result;
}
