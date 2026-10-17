"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, type ClinicAccess, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";
import { systemMessageDef, SYSTEM_MESSAGE_KEYS } from "@/lib/system-messages";
import { STAFF_ALERT_KINDS, STAFF_ALERT_ROLES, alertShape } from "@/lib/staff-alerts";
import {
  isStepKey,
  isTriggerKey,
  normalizeSettings,
  normalizeStepConfig,
  parseStepConfig,
  parseTriggerConfig,
  triggerDef,
} from "@/lib/automation/catalog";
import { blocking, validateFlow, type FlowEdge, type FlowNode, type Issue } from "@/lib/automation/graph";
import { loadFlow, queryRuns, reissueIds, writeFlowGraph, type RunRow } from "@/lib/automation/store";
import { loadRunContext } from "@/lib/automation/context";
import { renderMessage } from "@/lib/automation/variables";
import type { PoolClient } from "pg";
import { z } from "zod";

function canEdit(access: ClinicAccess): boolean {
  return can(access, "automations");
}

/* -------------------------------------------------------------------------
   Saving a flow
   ------------------------------------------------------------------------- */

const uuid = z.string().refine(isUuid, "uuid");
const position = z.object({ x: z.number().finite(), y: z.number().finite() });

const saveSchema = z.object({
  id: uuid.optional(),
  /** When the editor loaded the flow; a save over somebody else's newer one is refused. */
  baseUpdatedAt: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(""),
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
    .max(80),
  edges: z.array(z.object({ from: uuid.nullable(), handle: z.string().max(12), to: uuid })).max(300),
  active: z.boolean().default(false),
});

export type SaveFlowInput = z.input<typeof saveSchema>;

export type SaveFlowResult = {
  id?: string;
  updatedAt?: string;
  error?: "forbidden" | "invalid" | "invalid_flow" | "not_found" | "conflict" | "bad_media" | "bad_target";
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

export async function saveAutomationAction(slug: string, data: unknown): Promise<SaveFlowResult> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  const parsed = saveSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  const triggerConfig = parseTriggerConfig(d.trigger, d.triggerConfig);
  if (!triggerConfig.success) return { error: "invalid" };
  const nodes: FlowNode[] = [];
  for (const n of d.nodes) {
    const cfg = parseStepConfig(n.type, normalizeStepConfig(n.type, n.config));
    if (!cfg.success) return { error: "invalid" };
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
  if (d.active && blocking(issues)) return { error: "invalid_flow", issues };

  return inClinic(access, async (c) => {
    if (!(await checkTargets(c, access.clinicId, d.id, nodes))) return { error: "bad_target" as const };

    // A step id already used by another flow is not this flow's to overwrite.
    const foreign = await c.query(
      `select 1 from automation_steps where id = any($1::uuid[]) and (automation_id <> $2::uuid or clinic_id <> $3) limit 1`,
      [nodes.map((n) => n.id), d.id ?? "00000000-0000-0000-0000-000000000000", access.clinicId]
    );
    if (foreign.rowCount) return { error: "invalid" as const };

    const values = [
      d.name,
      d.description,
      d.trigger,
      JSON.stringify(triggerConfig.data),
      d.active,
      JSON.stringify(settings),
      JSON.stringify({ trigger: d.canvas.trigger ?? null }),
    ];
    let id = d.id;
    if (id) {
      const cur = (
        await c.query(`select updated_at from automations where id = $1 and clinic_id = $2 for update`, [
          id,
          access.clinicId,
        ])
      ).rows[0];
      if (!cur) return { error: "not_found" as const };
      if (d.baseUpdatedAt && new Date(cur.updated_at).getTime() !== new Date(d.baseUpdatedAt).getTime()) {
        return { error: "conflict" as const };
      }
      await c.query(
        `update automations set name = $3, description = $4, trigger_type = $5, trigger_config = $6, active = $7,
                settings = $8, canvas = $9
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, ...values]
      );
    } else {
      const r = await c.query(
        `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, settings, canvas)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [access.clinicId, ...values]
      );
      id = r.rows[0].id as string;
    }
    const { cancelledRuns } = await writeFlowGraph(c, access.clinicId, id!, nodes, edges);
    const updatedAt = new Date(
      (await c.query(`select updated_at from automations where id = $1`, [id])).rows[0].updated_at
    ).toISOString();
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "automation.update" : "automation.create",
      entity: "automation",
      entityId: id!,
      detail: { name: d.name, active: d.active, steps: nodes.length, cancelledRuns },
    });
    revalidatePath(`/c/${slug}/automations`);
    return { id, updatedAt, issues, cancelledRuns };
  });
}

/**
 * Switching a flow on from the list. The builder refuses to switch on a flow
 * with problems; so does this, or the list would be the way round it.
 */
export async function toggleAutomationAction(
  slug: string,
  id: string,
  active: boolean
): Promise<{ error?: "forbidden" | "not_found" | "invalid_flow" }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    if (active) {
      const flow = await loadFlow(c, access.clinicId, id);
      if (!flow) return { error: "not_found" as const };
      const issues = validateFlow({ ...flow, triggerConfig: flow.triggerConfig });
      if (blocking(issues)) return { error: "invalid_flow" as const };
    }
    const r = await c.query(`update automations set active = $3 where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
      active,
    ]);
    if (!r.rowCount) return { error: "not_found" as const };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "automation.toggle",
      entity: "automation",
      entityId: id,
      detail: { active },
    });
    revalidatePath(`/c/${slug}/automations`);
    return {};
  });
}

export async function deleteAutomationAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  await inClinic(access, async (c) => {
    const r = await c.query(`delete from automations where id = $1 and clinic_id = $2 returning name`, [
      id,
      access.clinicId,
    ]);
    if (r.rowCount) {
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "automation.delete",
        entity: "automation",
        entityId: id,
        detail: { name: r.rows[0].name },
      });
    }
  });
  revalidatePath(`/c/${slug}/automations`);
  return {};
}

/** A copy of a flow, switched off, to change without touching the original. */
export async function duplicateAutomationAction(
  slug: string,
  id: string,
  name: string
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const flow = await loadFlow(c, access.clinicId, id);
    if (!flow) return { error: "not_found" };
    const r = await c.query(
      `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, settings, canvas,
                                recipe_specialty)
       select clinic_id, $3, description, trigger_type, trigger_config, false, settings, canvas, recipe_specialty
         from automations where id = $1 and clinic_id = $2
       returning id`,
      [id, access.clinicId, name.trim().slice(0, 80) || flow.name]
    );
    const copyId = r.rows[0].id as string;
    const copy = reissueIds(flow.nodes, flow.edges);
    await writeFlowGraph(c, access.clinicId, copyId, copy.nodes, copy.edges);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "automation.duplicate",
      entity: "automation",
      entityId: copyId,
      detail: { from: id },
    });
    revalidatePath(`/c/${slug}/automations`);
    return { id: copyId };
  });
}

/* -------------------------------------------------------------------------
   Runs
   ------------------------------------------------------------------------- */

/**
 * Runs an automation now against a chosen patient (real messages).
 *
 * With the patient's own records as context, picked the way the trigger would:
 * their next appointment (or their latest), their latest open invoice, their
 * latest document, their thread. A test of a reminder against a patient with
 * no appointment would otherwise send "your appointment at " and nothing.
 */
export async function testRunAction(
  slug: string,
  automationId: string,
  patientId: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(automationId) || !isUuid(patientId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const auto = (
      await c.query(`select trigger_type from automations where id = $1 and clinic_id = $2`, [
        automationId,
        access.clinicId,
      ])
    ).rows[0];
    if (!auto) return { error: "not_found" };
    const patient = await c.query(`select 1 from patients where id = $1 and clinic_id = $2`, [patientId, access.clinicId]);
    if (!patient.rowCount) return { error: "not_found" };
    const provides = triggerDef(auto.trigger_type)?.provides ?? ["patient"];
    const pick = async (sql: string) => (await c.query(sql, [patientId, access.clinicId])).rows[0]?.id ?? null;
    const appointmentId = provides.includes("appointment")
      ? await pick(
          `select id from appointments where patient_id = $1 and clinic_id = $2
            order by (starts_at > now() and status in ('pending_approval', 'scheduled', 'confirmed')) desc,
                     abs(extract(epoch from starts_at - now())) limit 1`
        )
      : null;
    const invoiceId = provides.includes("invoice")
      ? await pick(
          `select id from invoices where patient_id = $1 and clinic_id = $2 and status <> 'void'
            order by (status in ('sent', 'partially_paid')) desc, created_at desc limit 1`
        )
      : null;
    const documentId = provides.includes("document")
      ? await pick(`select id from documents where patient_id = $1 and clinic_id = $2 order by created_at desc limit 1`)
      : null;
    const conversationId = provides.includes("conversation")
      ? await pick(
          `select id from conversations where patient_id = $1 and clinic_id = $2 order by last_message_at desc nulls last limit 1`
        )
      : null;
    const run = await c.query(
      `insert into automation_runs (clinic_id, automation_id, patient_id, appointment_id, invoice_id, document_id,
                                    conversation_id, status, context)
       values ($1, $2, $3, $4, $5, $6, $7, 'running', '{"test": true}')
       on conflict do nothing returning id`,
      [access.clinicId, automationId, patientId, appointmentId, invoiceId, documentId, conversationId]
    );
    if (!run.rowCount) return { error: "already_running" };
    await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'automation:advance', $2)`, [
      access.clinicId,
      JSON.stringify({ runId: run.rows[0].id }),
    ]);
    return {};
  });
}

async function cancelRuns(c: PoolClient, clinicId: string, where: string, params: unknown[]): Promise<number> {
  const r = await c.query(
    `update automation_runs set status = 'cancelled', finished_at = now(), wake_at = null, error = 'cancelled_by_staff'
      where clinic_id = $1 and status in ('running', 'waiting') and ${where}
      returning id`,
    [clinicId, ...params]
  );
  for (const row of r.rows) {
    await c.query(
      `insert into automation_run_logs (clinic_id, run_id, step_id, status, detail)
       values ($1, $2, null, 'cancelled', '{"reason":"cancelled_by_staff"}')`,
      [clinicId, row.id]
    );
  }
  return r.rowCount ?? 0;
}

export async function cancelRunAction(slug: string, runId: string): Promise<{ error?: string; cancelled?: number }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(runId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const n = await cancelRuns(c, access.clinicId, "id = $2", [runId]);
    if (n) {
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "automation.run.cancel",
        entity: "automation_run",
        entityId: runId,
        detail: {},
      });
    }
    return { cancelled: n };
  });
}

/** Stops every run of this flow that is still on its way, without switching it off. */
export async function cancelWaitingRunsAction(
  slug: string,
  automationId: string
): Promise<{ error?: string; cancelled?: number }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(automationId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const n = await cancelRuns(c, access.clinicId, "automation_id = $2", [automationId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "automation.run.cancel_all",
      entity: "automation",
      entityId: automationId,
      detail: { cancelled: n },
    });
    revalidatePath(`/c/${slug}/automations`);
    return { cancelled: n };
  });
}

/** A page of a flow's history, newest first, optionally only one status. */
export async function loadRunsAction(
  slug: string,
  automationId: string,
  opts: { status?: string; before?: string | null } = {}
): Promise<{ runs?: RunRow[]; error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(automationId)) return { error: "not_found" };
  const status = ["running", "waiting", "completed", "failed", "cancelled"].includes(opts.status ?? "")
    ? opts.status!
    : null;
  return inClinic(access, async (c) => ({ runs: await queryRuns(c, access.clinicId, automationId, status, opts.before ?? null) }));
}

/* -------------------------------------------------------------------------
   Preview
   ------------------------------------------------------------------------- */

/**
 * A message as one real patient would receive it, with their own next
 * appointment, open invoice and latest document filled in. Nothing is sent.
 */
export async function previewMessageAction(
  slug: string,
  input: { template: string; patientId: string }
): Promise<{ text?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  if (!isUuid(input.patientId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2`, [input.patientId, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" };
    const one = async (sql: string) => (await c.query(sql, [input.patientId, access.clinicId])).rows[0]?.id ?? null;
    const ctx = await loadRunContext(c, {
      clinicId: access.clinicId,
      patientId: input.patientId,
      appointmentId: await one(
        `select id from appointments where patient_id = $1 and clinic_id = $2
          order by (starts_at > now()) desc, abs(extract(epoch from starts_at - now())) limit 1`
      ),
      invoiceId: await one(
        `select id from invoices where patient_id = $1 and clinic_id = $2 and status <> 'void' order by created_at desc limit 1`
      ),
      documentId: await one(`select id from documents where patient_id = $1 and clinic_id = $2 order by created_at desc limit 1`),
    });
    return { text: renderMessage(String(input.template ?? "").slice(0, 4000), ctx) };
  });
}

/* -------------------------------------------------------------------------
   Built-in messages
   ------------------------------------------------------------------------- */

const systemMessageSchema = z.object({
  key: z.string().refine((k) => SYSTEM_MESSAGE_KEYS.includes(k), "unknown_key"),
  enabled: z.boolean(),
  ar: z.string().max(2000),
  en: z.string().max(2000),
});

/**
 * Saves a clinic's version of a built-in message.
 *
 * A body that matches the default is stored as an empty string rather than as a
 * copy of it. That is what keeps the clinic on the *current* default: if the
 * wording of a confirmation is improved next year, every clinic that never
 * changed it gets the improvement, and only the ones who actually wrote their
 * own keep theirs. Storing a copy would freeze every clinic on the day it first
 * opened the editor.
 *
 * When nothing is left to say — default wording, still switched on — the row is
 * deleted outright, so the override table only ever holds real decisions.
 */
export async function saveSystemMessageAction(
  slug: string,
  data: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  const parsed = systemMessageSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const def = systemMessageDef(d.key);
  if (!def) return { error: "invalid" };

  // A message the product will not let a clinic silence cannot be silenced by
  // posting to this action either.
  const enabled = def.canDisable ? d.enabled : true;
  const ar = d.ar.trim() === def.ar.trim() ? "" : d.ar.trim();
  const en = d.en.trim() === def.en.trim() ? "" : d.en.trim();

  await inClinic(access, async (c) => {
    if (enabled && !ar && !en) {
      await c.query(`delete from clinic_system_messages where clinic_id = $1 and key = $2`, [
        access.clinicId,
        d.key,
      ]);
    } else {
      await c.query(
        `insert into clinic_system_messages (clinic_id, key, enabled, body_ar, body_en)
         values ($1, $2, $3, $4, $5)
         on conflict (clinic_id, key) do update set
           enabled = excluded.enabled, body_ar = excluded.body_ar, body_en = excluded.body_en`,
        [access.clinicId, d.key, enabled, ar, en]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "automation.system_message",
      entity: "system_message",
      entityId: d.key,
      detail: { enabled, customised: Boolean(ar || en) },
    });
  });
  revalidatePath(`/c/${slug}/automations`);
  return {};
}

/* -------------------------------------------------------------------------
   Doctor and team alerts
   ------------------------------------------------------------------------- */

const staffAlertSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(STAFF_ALERT_KINDS),
  roles: z.array(z.enum(STAFF_ALERT_ROLES)).min(1),
  minutesBefore: z.number().int().min(0).max(1440).nullable().default(null),
  atHour: z.number().int().min(0).max(23).nullable().default(null),
  weekday: z.number().int().min(1).max(7).nullable().default(null),
  threshold: z.number().int().min(0).max(999).default(0),
  enabled: z.boolean().default(true),
});

export async function saveStaffAlertAction(
  slug: string,
  data: unknown
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  const parsed = staffAlertSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  /*
    Each kind uses a different pair of fields, and the ones it does not use are
    nulled here rather than trusted from the form. A stale `at_hour` left on an
    appointment reminder is invisible in the UI and would sit in the row looking
    like a setting somebody chose.
  */
  const shape = alertShape(d.kind);
  const minutes = shape.minutes ? d.minutesBefore : null;
  const hour = shape.hour ? (d.atHour ?? 8) : null;
  const weekday = shape.weekday ? (d.weekday ?? 7) : null;
  const threshold = shape.threshold ? d.threshold : 0;

  return inClinic(access, async (c) => {
    let id = d.id;
    if (id) {
      const r = await c.query(
        `update clinic_staff_alerts
            set kind = $3, roles = $4, minutes_before = $5, at_hour = $6, threshold = $7, enabled = $8,
                weekday = $9
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, d.kind, d.roles, minutes, hour, threshold, d.enabled, weekday]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, threshold, enabled, weekday, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 coalesce((select max(sort) + 1 from clinic_staff_alerts where clinic_id = $1), 0))
         returning id`,
        [access.clinicId, d.kind, d.roles, minutes, hour, threshold, d.enabled, weekday]
      );
      id = r.rows[0].id as string;
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "automation.alert.update" : "automation.alert.create",
      entity: "staff_alert",
      entityId: id!,
      detail: { kind: d.kind, roles: d.roles, minutes, hour, weekday, enabled: d.enabled },
    });
    revalidatePath(`/c/${slug}/automations`);
    return { id };
  });
}

export async function deleteStaffAlertAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  await inClinic(access, async (c) => {
    await c.query(`delete from clinic_staff_alerts where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "automation.alert.delete",
      entity: "staff_alert",
      entityId: id,
      detail: {},
    });
  });
  revalidatePath(`/c/${slug}/automations`);
  return {};
}
