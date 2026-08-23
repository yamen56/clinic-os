"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, type ClinicAccess, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { systemMessageDef, SYSTEM_MESSAGE_KEYS } from "@/lib/system-messages";
import { STAFF_ALERT_KINDS, STAFF_ALERT_ROLES, alertShape } from "@/lib/staff-alerts";
import type { PoolClient } from "pg";
import { z } from "zod";

function canEdit(access: ClinicAccess): boolean {
  return can(access, "automations");
}

const stepSchema: z.ZodType<StepInput> = z.lazy(() =>
  z.object({
    step_type: z.enum([
      "send_whatsapp", "wait", "condition", "add_tag", "remove_tag",
      "create_task", "notify_staff", "goto_automation", "send_document", "stop",
    ]),
    config: z.record(z.string(), z.unknown()).default({}),
    children: z
      .object({ yes: z.array(stepSchema).default([]), no: z.array(stepSchema).default([]) })
      .optional(),
  })
);

export type StepInput = {
  step_type: string;
  config: Record<string, unknown>;
  children?: { yes: StepInput[]; no: StepInput[] };
};

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(""),
  triggerType: z.enum([
    "appointment_created", "appointment_status_changed", "before_appointment",
    "after_last_visit", "patient_created", "waitlist_booked", "tag_added", "tag_removed", "birthday",
    "invoice_sent", "invoice_unpaid", "inbound_message", "booking_submitted",
  ]),
  triggerConfig: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(stepSchema).default([]),
  active: z.boolean().default(false),
});

async function writeSteps(
  c: PoolClient,
  clinicId: string,
  automationId: string,
  steps: StepInput[],
  parentId: string | null,
  branch: "yes" | "no" | null
) {
  let sort = 0;
  for (const s of steps) {
    const r = await c.query(
      `insert into automation_steps (clinic_id, automation_id, parent_step_id, branch, sort, step_type, config)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clinicId, automationId, parentId, branch, sort++, s.step_type, JSON.stringify(s.config ?? {})]
    );
    const id = r.rows[0].id as string;
    if (s.children?.yes?.length) await writeSteps(c, clinicId, automationId, s.children.yes, id, "yes");
    if (s.children?.no?.length) await writeSteps(c, clinicId, automationId, s.children.no, id, "no");
  }
}

export async function saveAutomationAction(
  slug: string,
  data: unknown
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  const parsed = saveSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    let id = d.id;
    if (id) {
      const r = await c.query(
        `update automations set name = $3, description = $4, trigger_type = $5, trigger_config = $6, active = $7
         where id = $1 and clinic_id = $2`,
        [id, access.clinicId, d.name, d.description, d.triggerType, JSON.stringify(d.triggerConfig), d.active]
      );
      if (!r.rowCount) return { error: "not_found" };
      await c.query(`delete from automation_steps where automation_id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ]);
    } else {
      const r = await c.query(
        `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [access.clinicId, d.name, d.description, d.triggerType, JSON.stringify(d.triggerConfig), d.active]
      );
      id = r.rows[0].id as string;
    }
    await writeSteps(c, access.clinicId, id!, d.steps, null, null);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "automation.update" : "automation.create",
      entity: "automation",
      entityId: id!,
      detail: { name: d.name, active: d.active },
    });
    revalidatePath(`/c/${slug}/automations`);
    return { id };
  });
}

export async function toggleAutomationAction(slug: string, id: string, active: boolean) {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return;
  await inClinic(access, async (c) => {
    await c.query(`update automations set active = $3 where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
      active,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "automation.toggle",
      entity: "automation",
      entityId: id,
      detail: { active },
    });
  });
  revalidatePath(`/c/${slug}/automations`);
}

export async function deleteAutomationAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return;
  await inClinic(access, (c) =>
    c.query(`delete from automations where id = $1 and clinic_id = $2`, [id, access.clinicId])
  );
  revalidatePath(`/c/${slug}/automations`);
}

/** Runs an automation now against a chosen patient (real messages). */
export async function testRunAction(
  slug: string,
  automationId: string,
  patientId: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    const auto = await c.query(`select id from automations where id = $1 and clinic_id = $2`, [
      automationId,
      access.clinicId,
    ]);
    if (!auto.rowCount) return { error: "not_found" };
    const run = await c.query(
      `insert into automation_runs (clinic_id, automation_id, patient_id, status, context)
       values ($1, $2, $3, 'running', '{"test": true}')
       on conflict do nothing returning id`,
      [access.clinicId, automationId, patientId]
    );
    if (!run.rowCount) return { error: "already_running" };
    await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'automation:advance', $2)`, [
      access.clinicId,
      JSON.stringify({ runId: run.rows[0].id }),
    ]);
    return {};
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
  const threshold = shape.threshold ? d.threshold : 0;

  return inClinic(access, async (c) => {
    let id = d.id;
    if (id) {
      const r = await c.query(
        `update clinic_staff_alerts
            set kind = $3, roles = $4, minutes_before = $5, at_hour = $6, threshold = $7, enabled = $8
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, d.kind, d.roles, minutes, hour, threshold, d.enabled]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, threshold, enabled, sort)
         values ($1, $2, $3, $4, $5, $6, $7,
                 coalesce((select max(sort) + 1 from clinic_staff_alerts where clinic_id = $1), 0))
         returning id`,
        [access.clinicId, d.kind, d.roles, minutes, hour, threshold, d.enabled]
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
      detail: { kind: d.kind, roles: d.roles, minutes, hour, enabled: d.enabled },
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
