import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { withSystem } from "./db";
import { loadContext, renderTemplate } from "./templates";
import { createAndSendFromTemplate } from "../src/lib/esign/flow";
import { staffInRoles } from "../src/lib/notify";

/**
 * Automation engine.
 *
 * Idempotency guarantees:
 * - one active run per (automation, patient, appointment, invoice) via a unique index
 * - steps advance only after their result is committed, so a retried job never
 *   re-sends the same message
 * - scheduled sends land inside the clinic's message window
 */

type Step = {
  id: string;
  parent_step_id: string | null;
  branch: "yes" | "no" | null;
  sort: number;
  step_type: string;
  config: Record<string, unknown>;
};

/** Next send time inside the clinic's allowed window (queues overnight traffic). */
export function withinWindow(
  from: DateTime,
  tz: string,
  windowStart: string,
  windowEnd: string
): DateTime {
  const local = from.setZone(tz);
  const [sh, sm] = windowStart.split(":").map(Number);
  const [eh, em] = windowEnd.split(":").map(Number);
  const start = local.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  let end = local.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  /*
    A window that closes at midnight closes at the *end* of the day. Read
    literally, 00:00 is the start of it — earlier than every opening time — so
    a clinic open "12:00 to 00:00" had its window collapse to nothing and every
    message pushed to noon the next day, one day late, forever. The same
    correction covers any window that runs past midnight, e.g. 20:00 to 02:00.
  */
  if (end <= start) end = end.plus({ days: 1 });

  /*
    Before today's opening is not the same as outside the window. When the
    window spans midnight, 01:00 belongs to the opening that began last
    night — sending then is exactly what the clinic asked for, and holding it
    until tonight would be nineteen hours late.
  */
  if (local < start) {
    const openedYesterday = local >= start.minus({ days: 1 }) && local < end.minus({ days: 1 });
    return openedYesterday ? local : start;
  }
  if (local >= end) return start.plus({ days: 1 });
  return local;
}

async function log(
  c: PoolClient,
  clinicId: string,
  runId: string,
  stepId: string | null,
  status: "ok" | "skipped" | "failed" | "waiting",
  detail: Record<string, unknown> = {}
) {
  await c.query(
    `insert into automation_run_logs (clinic_id, run_id, step_id, status, detail)
     values ($1, $2, $3, $4, $5)`,
    [clinicId, runId, stepId, status, JSON.stringify(detail)]
  );
}

/** Steps of an automation, ordered as a tree walk. */
async function loadSteps(c: PoolClient, automationId: string): Promise<Step[]> {
  const r = await c.query(
    `select id, parent_step_id, branch, sort, step_type, config
     from automation_steps where automation_id = $1 order by sort`,
    [automationId]
  );
  return r.rows as Step[];
}

function childrenOf(steps: Step[], parentId: string | null, branch: "yes" | "no" | null): Step[] {
  return steps
    .filter((s) => s.parent_step_id === parentId && (branch === null || s.branch === branch))
    .sort((a, b) => a.sort - b.sort);
}

/** The step that runs after `current` finishes (sibling, else parent's sibling). */
function nextAfter(steps: Step[], current: Step): Step | null {
  const siblings = childrenOf(steps, current.parent_step_id, current.branch);
  const idx = siblings.findIndex((s) => s.id === current.id);
  if (idx >= 0 && idx + 1 < siblings.length) return siblings[idx + 1];
  if (!current.parent_step_id) return null;
  const parent = steps.find((s) => s.id === current.parent_step_id);
  return parent ? nextAfter(steps, parent) : null;
}

/** Starts a run unless one is already active for this context. */
export async function startRun(
  c: PoolClient,
  clinicId: string,
  automationId: string,
  ctx: {
    patientId?: string | null;
    appointmentId?: string | null;
    invoiceId?: string | null;
    conversationId?: string | null;
    documentId?: string | null;
  }
): Promise<string | null> {
  const r = await c.query(
    `insert into automation_runs (clinic_id, automation_id, patient_id, appointment_id, invoice_id, conversation_id, document_id, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'running')
     on conflict do nothing
     returning id`,
    [
      clinicId,
      automationId,
      ctx.patientId ?? null,
      ctx.appointmentId ?? null,
      ctx.invoiceId ?? null,
      ctx.conversationId ?? null,
      ctx.documentId ?? null,
    ]
  );
  return r.rows[0]?.id ?? null;
}

/** Executes a run from its current position until it waits or completes. */
export async function advanceRun(runId: string): Promise<void> {
  await withSystem(async (c) => {
    const run = (
      await c.query(
        `select * from automation_runs where id = $1 and status in ('running', 'waiting') for update`,
        [runId]
      )
    ).rows[0];
    if (!run) return;

    const automation = (
      await c.query(`select * from automations where id = $1`, [run.automation_id])
    ).rows[0];
    if (!automation || !automation.active) {
      await c.query(
        `update automation_runs set status = 'cancelled', finished_at = now() where id = $1`,
        [runId]
      );
      return;
    }

    const clinic = (
      await c.query(
        `select timezone, message_window_start, message_window_end from clinics where id = $1`,
        [run.clinic_id]
      )
    ).rows[0];
    const steps = await loadSteps(c, run.automation_id);
    if (steps.length === 0) {
      await c.query(
        `update automation_runs set status = 'completed', finished_at = now() where id = $1`,
        [runId]
      );
      return;
    }

    const tmplCtx = await loadContext(c, {
      clinicId: run.clinic_id,
      patientId: run.patient_id,
      appointmentId: run.appointment_id,
      invoiceId: run.invoice_id,
      documentId: run.document_id,
    });

    // Resume after the last completed step, or start at the root
    let step: Step | null = run.current_step_id
      ? (() => {
          const cur = steps.find((s) => s.id === run.current_step_id);
          return cur ? nextAfter(steps, cur) : null;
        })()
      : (childrenOf(steps, null, null)[0] ?? null);

    let guard = 0;
    while (step && guard++ < 100) {
      const cfg = step.config ?? {};

      if (step.step_type === "wait") {
        const minutes = Number(cfg.minutes ?? 0);
        const untilTime = typeof cfg.until_time === "string" ? cfg.until_time : null;
        let wake: DateTime = DateTime.now().plus({ minutes: minutes || 0 });
        if (untilTime) {
          const [h, m] = untilTime.split(":").map(Number);
          const localNext = DateTime.now()
            .setZone(clinic.timezone)
            .plus({ minutes: minutes || 0 })
            .set({ hour: h, minute: m, second: 0, millisecond: 0 });
          wake = localNext <= DateTime.now().setZone(clinic.timezone)
            ? localNext.plus({ days: 1 })
            : localNext;
        }
        await c.query(
          `update automation_runs set status = 'waiting', current_step_id = $2, wake_at = $3 where id = $1`,
          [runId, step.id, wake.toUTC().toISO()]
        );
        await log(c, run.clinic_id, runId, step.id, "waiting", { wake_at: wake.toISO() });
        return;
      }

      if (step.step_type === "send_whatsapp") {
        const template = String(cfg.message ?? "");
        const body = renderTemplate(template, tmplCtx);
        const phone = tmplCtx.patient?.phone;
        if (!phone || !body.trim()) {
          await log(c, run.clinic_id, runId, step.id, "skipped", { reason: !phone ? "no_phone" : "empty" });
        } else {
          const sendAt = withinWindow(
            DateTime.now(),
            clinic.timezone,
            String(clinic.message_window_start).slice(0, 5),
            String(clinic.message_window_end).slice(0, 5)
          );
          const conv = await c.query(
            `insert into conversations (clinic_id, phone_e164, patient_id)
             values ($1, $2, $3)
             on conflict (clinic_id, phone_e164)
             do update set patient_id = coalesce(conversations.patient_id, excluded.patient_id)
             returning id`,
            [run.clinic_id, phone, run.patient_id]
          );
          // Idempotent across retries AND replayed triggers: the same automation
          // never sends the same text twice for the same patient/appointment/invoice.
          const existing = await c.query(
            `select 1 from messages m
             join automation_runs r on r.id = m.automation_run_id
             where m.clinic_id = $1 and m.body = $2
               and r.automation_id = $3
               and r.patient_id is not distinct from $4
               and r.appointment_id is not distinct from $5
               and r.invoice_id is not distinct from $6
             limit 1`,
            [run.clinic_id, body, run.automation_id, run.patient_id, run.appointment_id, run.invoice_id]
          );
          if (existing.rowCount) {
            await log(c, run.clinic_id, runId, step.id, "skipped", { reason: "already_sent" });
          } else {
            await c.query(
              `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body,
                                     status, scheduled_at, automation_run_id)
               values ($1, $2, 'out', 'automation', 'text', $3, 'queued', $4, $5)`,
              [run.clinic_id, conv.rows[0].id, body, sendAt.toUTC().toISO(), runId]
            );
            await c.query(
              `update conversations set last_message_at = now(), last_message_preview = $2, last_message_direction = 'out'
               where id = $1`,
              [conv.rows[0].id, body.slice(0, 120)]
            );
            await log(c, run.clinic_id, runId, step.id, "ok", { scheduled_at: sendAt.toISO() });
          }
        }
      } else if (step.step_type === "condition") {
        const result = await evaluateCondition(c, run, cfg);
        await log(c, run.clinic_id, runId, step.id, "ok", { branch: result ? "yes" : "no" });
        const branchChild = childrenOf(steps, step.id, result ? "yes" : "no")[0];
        if (branchChild) {
          await c.query(`update automation_runs set current_step_id = $2 where id = $1`, [runId, step.id]);
          step = branchChild;
          continue;
        }
      } else if (step.step_type === "add_tag" || step.step_type === "remove_tag") {
        const tag = String(cfg.tag ?? "").trim();
        if (tag && run.patient_id) {
          await c.query(
            step.step_type === "add_tag"
              ? `update patients set tags = array_append(tags, $2) where id = $1 and not ($2 = any(tags))`
              : `update patients set tags = array_remove(tags, $2) where id = $1`,
            [run.patient_id, tag]
          );
          await c.query(
            `insert into jobs (clinic_id, kind, payload) values ($1, $2, $3)`,
            [
              run.clinic_id,
              step.step_type === "add_tag" ? "trigger:tag_added" : "trigger:tag_removed",
              JSON.stringify({ patientId: run.patient_id, tag }),
            ]
          );
          await log(c, run.clinic_id, runId, step.id, "ok", { tag });
        } else {
          await log(c, run.clinic_id, runId, step.id, "skipped", {});
        }
      } else if (step.step_type === "create_task") {
        const title = renderTemplate(String(cfg.title ?? "Task"), tmplCtx);
        await c.query(
          `insert into tasks (clinic_id, title, body, patient_id, due_at, created_by)
           values ($1, $2, $3, $4, now() + ($5 * interval '1 minute'), 'automation')`,
          [
            run.clinic_id,
            title,
            renderTemplate(String(cfg.body ?? ""), tmplCtx),
            run.patient_id,
            Number(cfg.due_in_minutes ?? 1440),
          ]
        );
        await log(c, run.clinic_id, runId, step.id, "ok", { title });
      } else if (step.step_type === "notify_staff") {
        const title = renderTemplate(String(cfg.title ?? "Automation"), tmplCtx);
        const roles = Array.isArray(cfg.roles) && cfg.roles.length ? cfg.roles : ["owner", "receptionist"];
        // "owner" is a flag now, not a role value — see staffInRoles.
        const staff = await staffInRoles(c, run.clinic_id, roles as string[]);
        for (const userId of staff) {
          await c.query(
            `insert into notifications (clinic_id, user_id, kind, title, body) values ($1, $2, 'automation', $3, $4)`,
            [run.clinic_id, userId, title, renderTemplate(String(cfg.body ?? ""), tmplCtx)]
          );
        }
        await log(c, run.clinic_id, runId, step.id, "ok", { notified: staff.length });
      } else if (step.step_type === "send_document") {
        const templateId = String(cfg.template_id ?? "");
        if (!templateId || !run.patient_id) {
          await log(c, run.clinic_id, runId, step.id, "skipped", {
            reason: !templateId ? "no_template" : "no_patient",
          });
        } else {
          // The automation is the sender, so the document is created by whoever
          // owns the clinic — a document must always name a real person as its
          // creator, and an automation is not one.
          const owner = (
            await c.query(
              `select user_id from clinic_members
               where clinic_id = $1 and is_owner and active order by created_at limit 1`,
              [run.clinic_id]
            )
          ).rows[0];
          const sent = await createAndSendFromTemplate(c, {
            clinicId: run.clinic_id,
            userId: owner?.user_id ?? null,
            templateId,
            patientId: run.patient_id,
            appointmentId: run.appointment_id,
          });
          await log(
            c,
            run.clinic_id,
            runId,
            step.id,
            sent.ok ? "ok" : "failed",
            sent.ok
              ? { documentId: sent.documentId, delivered: sent.delivered }
              : { error: sent.error, missing: sent.missing ?? [] }
          );
        }
      } else if (step.step_type === "goto_automation") {
        const targetId = String(cfg.automation_id ?? "");
        if (targetId) {
          const target = await c.query(
            `select id from automations where id = $1 and clinic_id = $2 and active`,
            [targetId, run.clinic_id]
          );
          if (target.rowCount) {
            const newRun = await startRun(c, run.clinic_id, targetId, {
              patientId: run.patient_id,
              appointmentId: run.appointment_id,
              invoiceId: run.invoice_id,
            });
            if (newRun) {
              await c.query(
                `insert into jobs (clinic_id, kind, payload) values ($1, 'automation:advance', $2)`,
                [run.clinic_id, JSON.stringify({ runId: newRun })]
              );
            }
            await log(c, run.clinic_id, runId, step.id, "ok", { targetId });
          } else {
            await log(c, run.clinic_id, runId, step.id, "skipped", { reason: "target_inactive" });
          }
        }
      } else if (step.step_type === "stop") {
        await log(c, run.clinic_id, runId, step.id, "ok", {});
        break;
      }

      await c.query(`update automation_runs set current_step_id = $2 where id = $1`, [runId, step.id]);
      step = nextAfter(steps, step);
    }

    await c.query(
      `update automation_runs set status = 'completed', finished_at = now() where id = $1`,
      [runId]
    );
  });
}

async function evaluateCondition(
  c: PoolClient,
  run: Record<string, unknown>,
  cfg: Record<string, unknown>
): Promise<boolean> {
  const kind = String(cfg.kind ?? "has_tag");
  const clinicId = run.clinic_id as string;

  if (kind === "has_tag") {
    if (!run.patient_id) return false;
    const r = await c.query(`select tags from patients where id = $1`, [run.patient_id]);
    return (r.rows[0]?.tags ?? []).includes(String(cfg.tag ?? ""));
  }
  if (kind === "appointment_status") {
    if (!run.appointment_id) return false;
    const r = await c.query(`select status from appointments where id = $1`, [run.appointment_id]);
    return r.rows[0]?.status === String(cfg.status ?? "");
  }
  if (kind === "replied") {
    // Did the patient reply since this run started?
    const r = await c.query(
      `select 1 from messages m
       join conversations cv on cv.id = m.conversation_id
       where cv.clinic_id = $1 and cv.patient_id = $2 and m.direction = 'in'
         and m.created_at > $3 limit 1`,
      [clinicId, run.patient_id, run.started_at]
    );
    return (r.rowCount ?? 0) > 0;
  }
  if (kind === "invoice_paid") {
    if (!run.invoice_id) return false;
    const r = await c.query(`select status from invoices where id = $1`, [run.invoice_id]);
    return r.rows[0]?.status === "paid";
  }
  return false;
}

/** Matches a domain trigger to active automations and starts runs. */
export async function handleTrigger(
  kind: string,
  clinicId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await withSystem(async (c) => {
    const automations = await c.query(
      `select id, trigger_type, trigger_config from automations
       where clinic_id = $1 and active and trigger_type = $2`,
      [clinicId, kind]
    );
    for (const a of automations.rows) {
      const cfg = (a.trigger_config ?? {}) as Record<string, unknown>;

      if (kind === "appointment_status_changed") {
        const want = cfg.status ? String(cfg.status) : null;
        if (want && want !== payload.status) continue;
      }
      if (kind === "tag_added" || kind === "tag_removed") {
        const want = cfg.tag ? String(cfg.tag) : null;
        if (want && want !== payload.tag) continue;
      }
      if (kind === "inbound_message") {
        const keyword = cfg.keyword ? String(cfg.keyword).toLowerCase() : null;
        if (keyword && !String(payload.body ?? "").toLowerCase().includes(keyword)) continue;
      }

      const runId = await startRun(c, clinicId, a.id, {
        patientId: (payload.patientId as string) ?? null,
        appointmentId: (payload.appointmentId as string) ?? null,
        invoiceId: (payload.invoiceId as string) ?? null,
        conversationId: (payload.conversationId as string) ?? null,
        documentId: (payload.documentId as string) ?? null,
      });
      if (runId) {
        await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'automation:advance', $2)`, [
          clinicId,
          JSON.stringify({ runId }),
        ]);
      }
    }
  });
}
