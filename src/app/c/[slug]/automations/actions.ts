"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, type ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import type { PoolClient } from "pg";
import { z } from "zod";

function canEdit(access: ClinicAccess): boolean {
  return access.role === "owner" || access.permissions.automations === true;
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
    "after_last_visit", "patient_created", "tag_added", "tag_removed", "birthday",
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
