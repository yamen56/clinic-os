import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { withSystem } from "./db";
import { licensed } from "./features";
import { createAndSendFromTemplate } from "../src/lib/esign/flow";
import { notifyUser, staffInRoles } from "../src/lib/notify";
import { applyAppointmentStatus } from "../src/lib/appointments";
import {
  normalizeSettings,
  normalizeStepConfig,
  normalizeTriggerConfig,
  toMinutes,
  type ExitEvent,
  type Rule,
} from "../src/lib/automation/catalog";
import { loadRunContext } from "../src/lib/automation/context";
import { renderMessage, type TemplateContext } from "../src/lib/automation/variables";
import { normalizeForMatch, replyHandle, replyMatchesAny } from "../src/lib/automation/match";
import { legacyTreeEdges } from "../src/lib/automation/graph";

/**
 * Automation engine.
 *
 * A flow is a graph: steps, and an edge from each of a step's outputs to the
 * step that follows it (migration 0079). A run walks it from the trigger's edge
 * until it reaches a step with nowhere to go, a stop, or a wait.
 *
 * Guarantees:
 * - one active run per automation per context (patient, appointment, invoice,
 *   document, thread), by a unique index
 * - each step's work commits together with the run moving past it, so a retried
 *   job never repeats a step; a step that throws is rolled back on its own and
 *   the run is marked failed, rather than left "running" for ever
 * - a run resumes after a wait at the same edge whatever the flow was edited
 *   to meanwhile, because steps keep their ids across saves
 * - scheduled sends land inside the clinic's message window
 */

const MAX_CHAIN = 3;

type Step = { id: string; step_type: string; config: Record<string, unknown> };
type Edge = { from_step_id: string | null; handle: string; to_step_id: string };
type LogStatus = "ok" | "skipped" | "failed" | "waiting" | "cancelled";

type RunRow = {
  id: string;
  clinic_id: string;
  automation_id: string;
  patient_id: string | null;
  appointment_id: string | null;
  invoice_id: string | null;
  document_id: string | null;
  conversation_id: string | null;
  status: string;
  current_step_id: string | null;
  context: Record<string, unknown> | null;
  chain_depth: number;
  started_at: string;
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
  status: LogStatus,
  detail: Record<string, unknown> = {}
) {
  await c.query(
    `insert into automation_run_logs (clinic_id, run_id, step_id, status, detail)
     values ($1, $2, $3, $4, $5)`,
    [clinicId, runId, stepId, status, JSON.stringify(detail)]
  );
}

async function enqueueAdvance(c: PoolClient, clinicId: string, runId: string) {
  await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'automation:advance', $2)`, [
    clinicId,
    JSON.stringify({ runId }),
  ]);
}

export type RunContextIds = {
  patientId?: string | null;
  appointmentId?: string | null;
  invoiceId?: string | null;
  conversationId?: string | null;
  documentId?: string | null;
};

/**
 * Starts a run unless one is already active for this context, or unless it
 * should not run at all.
 *
 * Every run comes through here — a domain trigger, the scheduler's clock-driven
 * ones, one automation handing off to another — so this is where the rules
 * that apply to all of them live:
 *
 * - the clinic is live and still licensed for automations. The scheduler always
 *   checked this; the event triggers did not, so a clinic whose module had been
 *   switched off kept sending on every booking.
 * - the patient has not asked to be left alone. Checked here rather than at the
 *   send step, which would let the run log its way down the tree and fall
 *   silent at the end — reading as a broken automation, not a respected request.
 * - how often this flow may reach the same patient (`settings.reentry`).
 * - how deep a chain of automations has gone. One flow confirming an
 *   appointment starts the flows listening for confirmations, and a flow that
 *   tags starts the flows listening for tags; past MAX_CHAIN it stops, so two
 *   flows can never feed each other for ever.
 *
 * A run with no patient (an unknown number writing in) has nobody to have
 * opted out, and its re-entry is counted per thread instead.
 */
export async function startRun(
  c: PoolClient,
  clinicId: string,
  automationId: string,
  ctx: RunContextIds,
  opts: { chainDepth?: number; payload?: Record<string, unknown>; ignorePolicy?: boolean } = {}
): Promise<string | null> {
  const depth = opts.chainDepth ?? 0;
  if (depth > MAX_CHAIN) return null;

  const auto = (
    await c.query(
      `select a.settings from automations a join clinics cl on cl.id = a.clinic_id
        where a.id = $1 and a.clinic_id = $2 and ${licensed("automations")}`,
      [automationId, clinicId]
    )
  ).rows[0];
  if (!auto) return null;

  if (ctx.patientId) {
    const muted = await c.query(
      `select 1 from patients where id = $1 and clinic_id = $2 and automation_opt_out`,
      [ctx.patientId, clinicId]
    );
    if (muted.rowCount) return null;
  }

  const settings = normalizeSettings(auto.settings);
  if (!opts.ignorePolicy && settings.reentry !== "always") {
    const who = ctx.patientId
      ? { col: "patient_id", id: ctx.patientId }
      : ctx.conversationId
        ? { col: "conversation_id", id: ctx.conversationId }
        : null;
    if (who) {
      const seen = await c.query(
        `select 1 from automation_runs
          where automation_id = $1 and ${who.col} = $2 and status <> 'cancelled'
            and coalesce(context->>'test', 'false') <> 'true'
            ${settings.reentry === "cooldown" ? "and started_at > now() - ($3::int * interval '1 day')" : ""}
          limit 1`,
        settings.reentry === "cooldown"
          ? [automationId, who.id, settings.cooldown_days]
          : [automationId, who.id]
      );
      if (seen.rowCount) return null;
    }
  }

  const r = await c.query(
    `insert into automation_runs (clinic_id, automation_id, patient_id, appointment_id, invoice_id,
                                  conversation_id, document_id, status, context, chain_depth)
     values ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9)
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
      JSON.stringify(opts.payload ? { trigger: opts.payload } : {}),
      depth,
    ]
  );
  return r.rows[0]?.id ?? null;
}

/* -------------------------------------------------------------------------
   Running
   ------------------------------------------------------------------------- */

type Env = {
  c: PoolClient;
  run: RunRow;
  clinic: { timezone: string; message_window_start: string; message_window_end: string; features: unknown };
  steps: Step[];
  tmpl: () => Promise<TemplateContext>;
};

type StepResult =
  | { kind: "next"; handle: string; status: LogStatus; detail?: Record<string, unknown> }
  | {
      kind: "wait";
      wakeAt: DateTime;
      waitingFor: "time" | "reply";
      /** The output to take when the run wakes on its own. */
      resumeHandle: string;
      detail?: Record<string, unknown>;
    }
  | { kind: "stop" };

const next = (status: LogStatus, detail?: Record<string, unknown>): StepResult => ({
  kind: "next",
  handle: "next",
  status,
  detail,
});

async function cancelRun(c: PoolClient, run: RunRow, reason: string) {
  await c.query(
    `update automation_runs set status = 'cancelled', finished_at = now(), wake_at = null, error = $2 where id = $1`,
    [run.id, reason]
  );
  await log(c, run.clinic_id, run.id, null, "cancelled", { reason });
}

/** Marks a run failed from outside its own transaction: the job gave up on it. */
export async function failRun(runId: string, error: string): Promise<void> {
  await withSystem(async (c) => {
    const r = await c.query(
      `update automation_runs set status = 'failed', error = $2, finished_at = now(), wake_at = null
        where id = $1 and status in ('running', 'waiting') returning clinic_id, current_step_id`,
      [runId, error.slice(0, 500)]
    );
    if (r.rowCount) {
      await log(c, r.rows[0].clinic_id, runId, r.rows[0].current_step_id, "failed", { error: error.slice(0, 500) });
    }
  });
}

/**
 * Whether a run should stop early because what it was for has happened: the
 * appointment it is reminding about was cancelled, the invoice it is chasing
 * was paid, the patient booked again.
 */
async function exitReason(
  c: PoolClient,
  run: RunRow,
  exitOn: ExitEvent[],
  hasReplyStep: boolean
): Promise<ExitEvent | null> {
  for (const ev of exitOn) {
    if (ev === "appointment_cancelled" && run.appointment_id) {
      const r = await c.query(`select 1 from appointments where id = $1 and status = 'cancelled'`, [run.appointment_id]);
      if (r.rowCount) return ev;
    }
    if (ev === "appointment_booked" && run.patient_id) {
      const r = await c.query(
        `select 1 from appointments
          where patient_id = $1 and clinic_id = $2 and created_at > $3 and starts_at > now()
            and status in ('pending_approval', 'scheduled', 'confirmed')
            and id is distinct from $4
          limit 1`,
        [run.patient_id, run.clinic_id, run.started_at, run.appointment_id]
      );
      if (r.rowCount) return ev;
    }
    if (ev === "invoice_paid" && run.invoice_id) {
      const r = await c.query(`select 1 from invoices where id = $1 and status = 'paid'`, [run.invoice_id]);
      if (r.rowCount) return ev;
    }
    if (ev === "document_signed" && run.document_id) {
      const r = await c.query(`select 1 from documents where id = $1 and status = 'completed'`, [run.document_id]);
      if (r.rowCount) return ev;
    }
    // A flow that waits for a reply wants one; a reply cannot also be its reason to stop.
    if (ev === "patient_replied" && !hasReplyStep && (await repliedSince(c, run, run.started_at))) return ev;
  }
  return null;
}

async function repliedSince(c: PoolClient, run: RunRow, since: string): Promise<boolean> {
  if (!run.patient_id && !run.conversation_id) return false;
  const r = await c.query(
    `select 1 from messages m
       join conversations cv on cv.id = m.conversation_id
      where cv.clinic_id = $1 and m.direction = 'in' and m.created_at > $2
        and (cv.patient_id = $3 or cv.id = $4)
      limit 1`,
    [run.clinic_id, since, run.patient_id, run.conversation_id]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Executes a run from its current position until it waits or completes. */
export async function advanceRun(runId: string): Promise<void> {
  await withSystem(async (c) => {
    // Only a running run moves. A waiting one is woken by the clock or by a
    // reply, both of which set it running first — so a stray second job for a
    // waiting run can never skip its wait.
    const run = (
      await c.query(`select * from automation_runs where id = $1 and status = 'running' for update`, [runId])
    ).rows[0] as RunRow | undefined;
    if (!run) return;

    const automation = (
      await c.query(
        `select a.active, a.settings, a.canvas, ${licensed("automations")} as licensed
           from automations a join clinics cl on cl.id = a.clinic_id where a.id = $1`,
        [run.automation_id]
      )
    ).rows[0];
    if (!automation || !automation.active) return cancelRun(c, run, "automation_off");
    if (!automation.licensed) return cancelRun(c, run, "module_off");

    const clinic = (
      await c.query(
        `select timezone, message_window_start, message_window_end, features from clinics where id = $1`,
        [run.clinic_id]
      )
    ).rows[0];
    const stepRows = (
      await c.query(
        `select id, step_type, config, parent_step_id, branch, sort from automation_steps where automation_id = $1`,
        [run.automation_id]
      )
    ).rows;
    const steps = stepRows.map((s) => ({
      id: s.id,
      step_type: s.step_type,
      config: normalizeStepConfig(s.step_type, s.config),
    })) as Step[];
    let edges = (
      await c.query(`select from_step_id, handle, to_step_id from automation_edges where automation_id = $1`, [
        run.automation_id,
      ])
    ).rows as Edge[];
    // Written the old way (a script, or the previous web server mid-deploy): read the tree as edges.
    if (!edges.length && steps.length && !("trigger" in (automation.canvas ?? {}))) {
      edges = legacyTreeEdges(stepRows).map((e) => ({ from_step_id: e.from, handle: e.handle, to_step_id: e.to }));
    }
    const byId = new Map(steps.map((s) => [s.id, s]));
    const target = (from: string | null, handle: string): Step | null => {
      const e = edges.find((x) => x.from_step_id === from && x.handle === handle);
      return e ? (byId.get(e.to_step_id) ?? null) : null;
    };

    const settings = normalizeSettings(automation.settings);
    const exit = await exitReason(c, run, settings.exit_on, steps.some((s) => s.step_type === "wait_for_reply"));
    if (exit) {
      await log(c, run.clinic_id, run.id, null, "ok", { exited: exit });
      await c.query(`update automation_runs set status = 'completed', finished_at = now() where id = $1`, [run.id]);
      return;
    }

    const ctx = (run.context ?? {}) as Record<string, unknown>;
    const reply = (ctx.reply as { text?: string } | undefined)?.text ?? null;
    let cache: TemplateContext | null = null;
    const env: Env = {
      c,
      run,
      clinic,
      steps,
      tmpl: async () =>
        (cache ??= await loadRunContext(c, {
          clinicId: run.clinic_id,
          patientId: run.patient_id,
          appointmentId: run.appointment_id,
          invoiceId: run.invoice_id,
          documentId: run.document_id,
          reply,
        })),
    };

    // Where to carry on: the trigger's edge, or the output the last step took.
    let step: Step | null;
    if (!run.current_step_id) {
      step = target(null, "next");
    } else {
      const cur = byId.get(run.current_step_id);
      if (!cur) {
        await c.query(`update automation_runs set status = 'completed', finished_at = now() where id = $1`, [run.id]);
        return;
      }
      let handle = typeof ctx.resume_handle === "string" ? ctx.resume_handle : null;
      // A run that stopped mid-way before the edges existed: an if/else is
      // asked again rather than guessed.
      if (!handle) handle = cur.step_type === "condition" ? ((await evaluateCondition(env, cur.config)) ? "yes" : "no") : "next";
      step = target(cur.id, handle);
    }

    let guard = 0;
    while (step && guard++ < 100) {
      let res: StepResult;
      await c.query("savepoint automation_step");
      try {
        res = await runStep(env, step);
        await c.query("release savepoint automation_step");
      } catch (e) {
        await c.query("rollback to savepoint automation_step");
        const msg = ((e as Error).message || "error").slice(0, 500);
        await log(c, run.clinic_id, run.id, step.id, "failed", { error: msg });
        await c.query(
          `update automation_runs set status = 'failed', error = $2, finished_at = now(), current_step_id = $3 where id = $1`,
          [run.id, msg, step.id]
        );
        return;
      }

      if (res.kind === "wait") {
        await c.query(
          `update automation_runs
              set status = 'waiting', current_step_id = $2, wake_at = $3, waiting_for = $4,
                  context = coalesce(context, '{}'::jsonb) || jsonb_build_object('resume_handle', $5::text, 'waiting_since', now())
            where id = $1`,
          [run.id, step.id, res.wakeAt.toUTC().toISO(), res.waitingFor, res.resumeHandle]
        );
        await log(c, run.clinic_id, run.id, step.id, "waiting", { wake_at: res.wakeAt.toISO(), ...res.detail });
        return;
      }
      if (res.kind === "stop") {
        await log(c, run.clinic_id, run.id, step.id, "ok", {});
        break;
      }
      await log(c, run.clinic_id, run.id, step.id, res.status, {
        ...(res.handle !== "next" ? { branch: res.handle } : {}),
        ...res.detail,
      });
      await c.query(
        `update automation_runs set current_step_id = $2,
                context = coalesce(context, '{}'::jsonb) || jsonb_build_object('resume_handle', $3::text)
          where id = $1`,
        [run.id, step.id, res.handle]
      );
      step = target(step.id, res.handle);
    }

    await c.query(`update automation_runs set status = 'completed', finished_at = now() where id = $1`, [run.id]);
  });
}

/* -------------------------------------------------------------------------
   Steps
   ------------------------------------------------------------------------- */

async function runStep(env: Env, step: Step): Promise<StepResult> {
  const { c, run } = env;
  const cfg = step.config;
  const str = (k: string) => String(cfg[k] ?? "").trim();

  switch (step.step_type) {
    case "send_whatsapp":
      return sendWhatsapp(env, cfg);

    case "send_document": {
      const templateId = str("template_id");
      if (!templateId || !run.patient_id) return next("skipped", { reason: !templateId ? "no_template" : "no_patient" });
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
      return sent.ok
        ? next("ok", { documentId: sent.documentId, delivered: sent.delivered })
        : next("failed", { error: sent.error, missing: sent.missing ?? [] });
    }

    case "wait":
      return waitStep(env, cfg);

    case "wait_for_reply": {
      if (!run.patient_id && !run.conversation_id) return { kind: "next", handle: "timeout", status: "skipped", detail: { reason: "no_patient" } };
      const minutes = toMinutes(Number(cfg.amount) || 24, String(cfg.unit));
      return {
        kind: "wait",
        wakeAt: DateTime.now().plus({ minutes }),
        waitingFor: "reply",
        resumeHandle: "timeout",
        detail: { for: "reply" },
      };
    }

    case "condition": {
      const yes = await evaluateCondition(env, cfg);
      return { kind: "next", handle: yes ? "yes" : "no", status: "ok" };
    }

    case "goto_automation": {
      const targetId = str("automation_id");
      const target = targetId
        ? await c.query(`select id from automations where id = $1 and clinic_id = $2 and active`, [targetId, run.clinic_id])
        : null;
      if (!target?.rowCount) return next("skipped", { reason: "target_inactive" });
      const newRun = await startRun(
        c,
        run.clinic_id,
        targetId,
        {
          patientId: run.patient_id,
          appointmentId: run.appointment_id,
          invoiceId: run.invoice_id,
          documentId: run.document_id,
          conversationId: run.conversation_id,
        },
        { chainDepth: run.chain_depth + 1 }
      );
      if (newRun) await enqueueAdvance(c, run.clinic_id, newRun);
      return next(newRun ? "ok" : "skipped", newRun ? { targetId } : { reason: "not_started" });
    }

    case "stop":
      return { kind: "stop" };

    case "add_tag":
    case "remove_tag": {
      const tag = str("tag");
      if (!tag || !run.patient_id) return next("skipped", { reason: !tag ? "no_tag" : "no_patient" });
      const adding = step.step_type === "add_tag";
      const r = await c.query(
        adding
          ? `update patients set tags = array_append(tags, $2) where id = $1 and not ($2 = any(tags))`
          : `update patients set tags = array_remove(tags, $2) where id = $1 and $2 = any(tags)`,
        [run.patient_id, tag]
      );
      if (adding) {
        await c.query(
          `insert into clinic_tags (clinic_id, name) values ($1, $2) on conflict (clinic_id, name) do nothing`,
          [run.clinic_id, tag]
        );
      }
      // Only a real change is news to the flows listening for this tag.
      if (r.rowCount) {
        await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, $2, $3)`, [
          run.clinic_id,
          adding ? "trigger:tag_added" : "trigger:tag_removed",
          JSON.stringify({ patientId: run.patient_id, tag, chainDepth: run.chain_depth + 1 }),
        ]);
      }
      return next(r.rowCount ? "ok" : "skipped", r.rowCount ? { tag } : { tag, reason: "unchanged" });
    }

    case "update_patient": {
      if (!run.patient_id) return next("skipped", { reason: "no_patient" });
      if (cfg.field === "custom") {
        const key = str("key");
        if (!key) return next("skipped", { reason: "no_field" });
        const value = renderMessage(String(cfg.value ?? ""), await env.tmpl());
        await c.query(
          `update patients set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object($2::text, $3::text)
            where id = $1`,
          [run.patient_id, key, value]
        );
        return next("ok", { field: key });
      }
      await c.query(`update patients set status = $2 where id = $1`, [run.patient_id, String(cfg.status)]);
      return next("ok", { status: cfg.status });
    }

    case "add_note": {
      if (!run.patient_id) return next("skipped", { reason: "no_patient" });
      const body = renderMessage(String(cfg.body ?? ""), await env.tmpl());
      if (!body) return next("skipped", { reason: "empty" });
      await c.query(
        `insert into patient_notes (clinic_id, patient_id, author_id, appointment_id, kind, body)
         values ($1, $2, null, $3, 'admin', $4)`,
        [run.clinic_id, run.patient_id, run.appointment_id, body]
      );
      return next("ok");
    }

    case "update_appointment": {
      if (!run.appointment_id) return next("skipped", { reason: "no_appointment" });
      const status = cfg.status === "cancelled" ? "cancelled" : "confirmed";
      /*
        A patient's "1" confirms an appointment that is still waiting to be;
        it never revives one the desk has since cancelled or finished. And a
        cancellation by reply only touches an appointment that is still ahead.
      */
      const r = await applyAppointmentStatus(c, {
        clinicId: run.clinic_id,
        appointmentId: run.appointment_id,
        status,
        actorUserId: null,
        onlyFrom: status === "confirmed" ? ["pending_approval", "scheduled", "confirmed"] : ["pending_approval", "scheduled", "confirmed"],
        chainDepth: run.chain_depth + 1,
      });
      if (!r.ok) return next("skipped", { reason: r.error, current: r.previousStatus });
      return next(r.changed ? "ok" : "skipped", r.changed ? { status } : { status, reason: "unchanged" });
    }

    case "assign_conversation": {
      const conv = await conversationOf(env);
      if (!conv) return next("skipped", { reason: "no_conversation" });
      let userId: string | null = null;
      if (cfg.target === "member") userId = await memberUser(c, run.clinic_id, str("member_id"));
      if (cfg.target === "appointment_doctor") userId = await appointmentDoctorUser(c, run.appointment_id);
      if (cfg.target !== "nobody" && !userId) return next("skipped", { reason: "no_member" });
      await c.query(`update conversations set assigned_to = $2 where id = $1`, [conv, userId]);
      return next("ok");
    }

    case "set_ai": {
      const conv = await conversationOf(env);
      if (!conv) return next("skipped", { reason: "no_conversation" });
      if (cfg.mode === "on") {
        await c.query(`update conversations set ai_enabled = true, ai_paused_until = null where id = $1`, [conv]);
      } else if (cfg.mode === "off") {
        await c.query(`update conversations set ai_enabled = false where id = $1`, [conv]);
      } else {
        const minutes = toMinutes(Number(cfg.amount) || 24, String(cfg.unit));
        await c.query(
          `update conversations set ai_paused_until = now() + ($2::int * interval '1 minute') where id = $1`,
          [conv, Math.round(minutes)]
        );
      }
      return next("ok", { mode: cfg.mode });
    }

    case "flag_conversation": {
      const conv = await conversationOf(env);
      if (!conv) return next("skipped", { reason: "no_conversation" });
      const reason = renderMessage(String(cfg.reason ?? ""), await env.tmpl()).slice(0, 200);
      await c.query(`update conversations set flagged = true, flag_reason = $2, status = 'open' where id = $1`, [
        conv,
        reason || null,
      ]);
      return next("ok");
    }

    case "close_conversation": {
      const conv = await conversationOf(env);
      if (!conv) return next("skipped", { reason: "no_conversation" });
      await c.query(`update conversations set status = 'closed' where id = $1`, [conv]);
      return next("ok");
    }

    case "create_task": {
      const tmpl = await env.tmpl();
      const title = renderMessage(String(cfg.title ?? ""), tmpl) || "Task";
      let assignee: string | null = null;
      if (cfg.assignee === "member") assignee = await memberUser(c, run.clinic_id, str("member_id"));
      if (cfg.assignee === "appointment_doctor") assignee = await appointmentDoctorUser(c, run.appointment_id);
      const minutes = Math.round(toMinutes(Number(cfg.due_amount) || 0, String(cfg.due_unit)));
      await c.query(
        `insert into tasks (clinic_id, title, body, patient_id, assigned_to, due_at, created_by)
         values ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 minute'), 'automation')`,
        [run.clinic_id, title.slice(0, 200), renderMessage(String(cfg.body ?? ""), tmpl), run.patient_id, assignee, minutes]
      );
      return next("ok", { title });
    }

    case "notify_staff": {
      const tmpl = await env.tmpl();
      const title = renderMessage(String(cfg.title ?? ""), tmpl) || "Automation";
      const body = renderMessage(String(cfg.body ?? ""), tmpl);
      const roles = Array.isArray(cfg.roles) ? (cfg.roles as string[]) : [];
      // "owner" is a flag now, not a role value — see staffInRoles.
      const users = new Set<string>(roles.length ? await staffInRoles(c, run.clinic_id, roles) : []);
      const memberIds = Array.isArray(cfg.member_ids) ? (cfg.member_ids as string[]) : [];
      if (memberIds.length) {
        const r = await c.query(
          `select user_id from clinic_members where clinic_id = $1 and active and id = any($2::uuid[])`,
          [run.clinic_id, memberIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x))]
        );
        for (const row of r.rows) users.add(row.user_id);
      }
      if (cfg.appointment_doctor) {
        const doc = await appointmentDoctorUser(c, run.appointment_id);
        if (doc) users.add(doc);
      }
      const slug = (await c.query(`select slug from clinics where id = $1`, [run.clinic_id])).rows[0]?.slug;
      const url = run.patient_id ? `/c/${slug}/patients/${run.patient_id}` : run.conversation_id ? `/c/${slug}/conversations` : undefined;
      for (const userId of users) {
        await notifyUser(c, userId, { clinicId: run.clinic_id, kind: "automation", title, body, url });
      }
      return next(users.size ? "ok" : "skipped", { notified: users.size });
    }
  }
  return next("skipped", { reason: "unknown_step" });
}

async function memberUser(c: PoolClient, clinicId: string, memberId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(memberId)) return null;
  const r = await c.query(`select user_id from clinic_members where id = $1 and clinic_id = $2 and active`, [
    memberId,
    clinicId,
  ]);
  return r.rows[0]?.user_id ?? null;
}

async function appointmentDoctorUser(c: PoolClient, appointmentId: string | null): Promise<string | null> {
  if (!appointmentId) return null;
  const r = await c.query(
    `select cm.user_id from appointments a join clinic_members cm on cm.id = a.doctor_member_id
      where a.id = $1 and cm.active`,
    [appointmentId]
  );
  return r.rows[0]?.user_id ?? null;
}

/**
 * The thread a run is about: the one that started it, else the patient's most
 * recent. Never rebuilt from a phone number — a thread addressed by WhatsApp
 * identity has no number to rebuild it from.
 */
async function conversationOf(env: Env): Promise<string | null> {
  const { c, run } = env;
  if (run.conversation_id) {
    const r = await c.query(`select id from conversations where id = $1 and clinic_id = $2`, [
      run.conversation_id,
      run.clinic_id,
    ]);
    if (r.rowCount) return r.rows[0].id;
  }
  if (!run.patient_id) return null;
  const r = await c.query(
    `select id from conversations where clinic_id = $1 and patient_id = $2
      order by last_message_at desc nulls last limit 1`,
    [run.clinic_id, run.patient_id]
  );
  return r.rows[0]?.id ?? null;
}

async function sendWhatsapp(env: Env, cfg: Record<string, unknown>): Promise<StepResult> {
  const { c, run, clinic } = env;
  const body = renderMessage(String(cfg.message ?? ""), await env.tmpl());
  const media = (cfg.media ?? null) as { path: string; kind: "image" | "document"; name: string; mime: string } | null;
  if (!body.trim() && !media) return next("skipped", { reason: "empty" });

  /*
    Where it goes. A run started by a message replies in that thread, which is
    the only address an unknown number has — rebuilding one from digits is how
    sends to identity-addressed chats vanished without an error. Otherwise the
    patient's own number, as it always was.
  */
  let conversationId: string | null = null;
  if (run.conversation_id) {
    const r = await c.query(`select id from conversations where id = $1 and clinic_id = $2`, [
      run.conversation_id,
      run.clinic_id,
    ]);
    conversationId = r.rows[0]?.id ?? null;
  }
  if (!conversationId) {
    const phone = run.patient_id
      ? (await c.query(`select phone_e164 from patients where id = $1`, [run.patient_id])).rows[0]?.phone_e164
      : null;
    if (!phone) return next("skipped", { reason: "no_phone" });
    const conv = await c.query(
      `insert into conversations (clinic_id, phone_e164, patient_id)
       values ($1, $2, $3)
       on conflict (clinic_id, phone_e164)
       do update set patient_id = coalesce(conversations.patient_id, excluded.patient_id)
       returning id`,
      [run.clinic_id, phone, run.patient_id]
    );
    conversationId = conv.rows[0].id as string;
  }

  // Idempotent across retries AND replayed triggers: the same automation never
  // sends the same text twice for the same patient/appointment/invoice.
  const existing = await c.query(
    `select 1 from messages m
     join automation_runs r on r.id = m.automation_run_id
     where m.clinic_id = $1 and m.body = $2
       and m.media_path is not distinct from $7
       and r.automation_id = $3
       and r.patient_id is not distinct from $4
       and r.appointment_id is not distinct from $5
       and r.invoice_id is not distinct from $6
       and r.conversation_id is not distinct from $8
     limit 1`,
    [
      run.clinic_id, body, run.automation_id, run.patient_id, run.appointment_id, run.invoice_id,
      media?.path ?? null, run.conversation_id,
    ]
  );
  if (existing.rowCount) return next("skipped", { reason: "already_sent" });

  const sendAt = withinWindow(
    DateTime.now(),
    clinic.timezone,
    String(clinic.message_window_start).slice(0, 5),
    String(clinic.message_window_end).slice(0, 5)
  );
  await c.query(
    `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body,
                           media_path, media_name, media_mime, status, scheduled_at, automation_run_id)
     values ($1, $2, 'out', 'automation', $3, $4, $5, $6, $7, 'queued', $8, $9)`,
    [
      run.clinic_id,
      conversationId,
      media ? media.kind : "text",
      body,
      media?.path ?? null,
      media?.name || null,
      media?.mime || null,
      sendAt.toUTC().toISO(),
      run.id,
    ]
  );
  await c.query(
    `update conversations set last_message_at = now(), last_message_preview = $2, last_message_direction = 'out'
     where id = $1`,
    [conversationId, body ? body.slice(0, 120) : `[${media?.kind ?? "media"}]`]
  );
  return next("ok", { scheduled_at: sendAt.toISO() });
}

/**
 * The three ways to wait: for a while; until a time of day (on the day the
 * delay lands, or the next day if that time has gone, optionally only on
 * certain weekdays); or until a point before or after the appointment.
 */
async function waitStep(env: Env, cfg: Record<string, unknown>): Promise<StepResult> {
  const { c, run, clinic } = env;
  const now = DateTime.now();
  const minutes = toMinutes(Math.max(0, Number(cfg.amount) || 0), String(cfg.unit));

  if (cfg.mode === "appointment") {
    if (!run.appointment_id) return next("skipped", { reason: "no_appointment" });
    const a = (await c.query(`select starts_at from appointments where id = $1`, [run.appointment_id])).rows[0];
    if (!a) return next("skipped", { reason: "no_appointment" });
    const start = DateTime.fromJSDate(new Date(a.starts_at));
    const at = cfg.direction === "after" ? start.plus({ minutes }) : start.minus({ minutes });
    // Already past: carry straight on rather than wait for a moment that has gone.
    if (at <= now) return next("ok", { reason: "already_due" });
    return { kind: "wait", wakeAt: at, waitingFor: "time", resumeHandle: "next" };
  }

  if (cfg.mode === "until_time") {
    const [h, m] = String(cfg.time ?? "09:00").split(":").map(Number);
    const localNow = now.setZone(clinic.timezone);
    let at = localNow.plus({ minutes }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (at <= localNow) at = at.plus({ days: 1 });
    const days = Array.isArray(cfg.weekdays) ? (cfg.weekdays as number[]) : [];
    for (let i = 0; days.length && !days.includes(at.weekday) && i < 7; i++) at = at.plus({ days: 1 });
    return { kind: "wait", wakeAt: at, waitingFor: "time", resumeHandle: "next" };
  }

  return { kind: "wait", wakeAt: now.plus({ minutes }), waitingFor: "time", resumeHandle: "next" };
}

/* -------------------------------------------------------------------------
   Conditions
   ------------------------------------------------------------------------- */

async function evaluateCondition(env: Env, cfg: Record<string, unknown>): Promise<boolean> {
  const rules = (Array.isArray(cfg.rules) ? cfg.rules : []) as Rule[];
  if (!rules.length) return false;
  const cache = new Map<string, unknown>();
  const results: boolean[] = [];
  for (const r of rules) {
    const v = await evaluateRule(env, r, cache);
    results.push(r.negate ? !v : v);
    // Short-circuit like a person reading it would.
    if (cfg.match === "any" && results[results.length - 1]) return true;
    if (cfg.match !== "any" && !results[results.length - 1]) return false;
  }
  return cfg.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

async function evaluateRule(env: Env, r: Rule, cache: Map<string, unknown>): Promise<boolean> {
  const { c, run, clinic } = env;
  const once = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, await fn());
    return cache.get(key) as T;
  };
  const patient = () =>
    once("patient", async () =>
      run.patient_id
        ? (
            await c.query(
              `select tags, gender, birth_date, source, status, custom_fields from patients where id = $1`,
              [run.patient_id]
            )
          ).rows[0] ?? null
        : null
    );
  const appointment = () =>
    once("appointment", async () =>
      run.appointment_id
        ? (await c.query(`select status, service_id, doctor_member_id from appointments where id = $1`, [run.appointment_id]))
            .rows[0] ?? null
        : null
    );
  const values = r.values ?? [];

  switch (r.kind) {
    case "has_tag": {
      const p = await patient();
      return Boolean(p && r.value && (p.tags ?? []).includes(r.value.trim()));
    }
    case "gender": {
      const p = await patient();
      return Boolean(p && p.gender && p.gender === r.value);
    }
    case "age_between": {
      const p = await patient();
      if (!p?.birth_date) return false;
      const age = Math.floor(DateTime.now().diff(DateTime.fromJSDate(new Date(p.birth_date)), "years").years);
      return (r.number == null || age >= r.number) && (r.number2 == null || age <= r.number2);
    }
    case "patient_source": {
      const p = await patient();
      return Boolean(p && values.includes(p.source));
    }
    case "patient_status": {
      const p = await patient();
      return Boolean(p && values.includes(p.status));
    }
    case "custom_field": {
      const p = await patient();
      if (!p || !r.key) return false;
      const raw = (p.custom_fields ?? {})[r.key];
      const v = raw == null ? "" : String(raw);
      if (r.op === "empty") return !v.trim();
      if (r.op === "not_empty") return Boolean(v.trim());
      if (r.op === "contains") return normalizeForMatch(v).includes(normalizeForMatch(r.value));
      return normalizeForMatch(v) === normalizeForMatch(r.value);
    }
    case "has_upcoming_appointment": {
      if (!run.patient_id) return false;
      const q = await c.query(
        `select 1 from appointments where patient_id = $1 and clinic_id = $2 and starts_at > now()
            and status in ('pending_approval', 'scheduled', 'confirmed')
            and id is distinct from $3 limit 1`,
        [run.patient_id, run.clinic_id, run.appointment_id]
      );
      return (q.rowCount ?? 0) > 0;
    }
    case "visits_at_least": {
      if (!run.patient_id) return false;
      const q = await c.query(
        `select count(*)::int as n from appointments where patient_id = $1 and clinic_id = $2 and status = 'completed'`,
        [run.patient_id, run.clinic_id]
      );
      return q.rows[0].n >= (r.number ?? 1);
    }
    case "first_visit": {
      if (!run.patient_id) return false;
      // No finished visit other than the one this run is about.
      const q = await c.query(
        `select 1 from appointments where patient_id = $1 and clinic_id = $2 and status = 'completed'
            and id is distinct from $3 limit 1`,
        [run.patient_id, run.clinic_id, run.appointment_id]
      );
      return !q.rowCount;
    }
    case "appointment_status": {
      const a = await appointment();
      return Boolean(a && values.includes(a.status));
    }
    case "appointment_service": {
      const a = await appointment();
      return Boolean(a && a.service_id && values.includes(a.service_id));
    }
    case "appointment_doctor": {
      const a = await appointment();
      return Boolean(a && a.doctor_member_id && values.includes(a.doctor_member_id));
    }
    case "replied":
      return repliedSince(c, run, run.started_at);
    case "reply_contains": {
      const reply = await latestReply(env);
      return Boolean(reply && replyMatchesAny(reply, values));
    }
    case "invoice_paid": {
      if (!run.invoice_id) return false;
      const q = await c.query(`select status from invoices where id = $1`, [run.invoice_id]);
      return q.rows[0]?.status === "paid";
    }
    case "invoice_balance_above": {
      if (!run.invoice_id) return false;
      const q = await c.query(`select total - amount_paid as balance from invoices where id = $1`, [run.invoice_id]);
      return q.rowCount ? Number(q.rows[0].balance) > (r.number ?? 0) : false;
    }
    case "document_status": {
      if (!run.document_id) return false;
      const q = await c.query(`select status from documents where id = $1`, [run.document_id]);
      return Boolean(q.rows[0] && values.includes(q.rows[0].status));
    }
    case "weekday": {
      const wd = DateTime.now().setZone(clinic.timezone).weekday;
      return values.includes(String(wd));
    }
    case "time_between": {
      const local = DateTime.now().setZone(clinic.timezone).toFormat("HH:mm");
      if (!r.value || !r.value2) return false;
      // A window across midnight (22:00–06:00) is the two ends of the day.
      return r.value <= r.value2 ? local >= r.value && local < r.value2 : local >= r.value || local < r.value2;
    }
  }
  return false;
}

/** The reply this run is holding, else the patient's latest message since it began. */
async function latestReply(env: Env): Promise<string | null> {
  const { c, run } = env;
  const held = ((run.context ?? {}) as { reply?: { text?: string } }).reply?.text;
  if (held) return held;
  const trigger = ((run.context ?? {}) as { trigger?: { body?: string } }).trigger?.body;
  if (trigger) return trigger;
  if (!run.patient_id && !run.conversation_id) return null;
  const r = await c.query(
    `select m.body from messages m join conversations cv on cv.id = m.conversation_id
      where cv.clinic_id = $1 and m.direction = 'in' and m.created_at > $2
        and (cv.patient_id = $3 or cv.id = $4)
      order by m.created_at desc limit 1`,
    [run.clinic_id, run.started_at, run.patient_id, run.conversation_id]
  );
  return r.rows[0]?.body ?? null;
}

/* -------------------------------------------------------------------------
   Triggers
   ------------------------------------------------------------------------- */

/**
 * Hands a patient's message to the runs waiting for one.
 *
 * Claimed with a conditional update, so the reply and the timeout cannot both
 * wake the same run: whichever moves it out of `waiting` first wins, and the
 * other finds nothing to do. Returns how many runs took the reply — when any
 * did, the AI receptionist is left out of it (see jobs.ts), or it would answer
 * the "1" a reminder asked for.
 */
export async function resumeOnReply(
  clinicId: string,
  payload: { conversationId?: string | null; patientId?: string | null; body?: string | null }
): Promise<number> {
  const body = String(payload.body ?? "").trim();
  if (!payload.conversationId && !payload.patientId) return 0;
  return withSystem(async (c) => {
    const waiting = await c.query(
      `select r.id, r.current_step_id from automation_runs r
        where r.clinic_id = $1 and r.status = 'waiting' and r.waiting_for = 'reply'
          and (r.conversation_id = $2 or (r.patient_id is not null and r.patient_id = $3))
        for update skip locked`,
      [clinicId, payload.conversationId ?? null, payload.patientId ?? null]
    );
    let taken = 0;
    for (const w of waiting.rows) {
      const step = (await c.query(`select config from automation_steps where id = $1`, [w.current_step_id])).rows[0];
      const cfg = normalizeStepConfig("wait_for_reply", step?.config ?? {});
      const handle = replyHandle(body, (cfg.options as { keywords: string[] }[]) ?? []);
      const r = await c.query(
        `update automation_runs
            set status = 'running', wake_at = null, waiting_for = null,
                context = coalesce(context, '{}'::jsonb)
                          || jsonb_build_object('resume_handle', $2::text,
                                                'reply', jsonb_build_object('text', $3::text, 'at', now()))
          where id = $1 and status = 'waiting'
          returning id`,
        [w.id, handle, body.slice(0, 2000)]
      );
      if (r.rowCount) {
        await log(c, clinicId, w.id, w.current_step_id, "ok", { branch: handle, reply: body.slice(0, 200) });
        await enqueueAdvance(c, clinicId, w.id);
        taken++;
      }
    }
    return taken;
  });
}

/**
 * Whether one automation's trigger settings accept this event: the right
 * status, service, doctor, source, keyword. Anything the event cannot answer
 * (no appointment to check a service against) is a no.
 */
async function matchesTrigger(
  c: PoolClient,
  clinicId: string,
  kind: string,
  cfg: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<boolean> {
  const list = (k: string) => (Array.isArray(cfg[k]) ? (cfg[k] as string[]) : []);

  if (kind === "appointment_status_changed" && cfg.status && cfg.status !== payload.status) return false;
  if ((kind === "tag_added" || kind === "tag_removed") && cfg.tag && cfg.tag !== payload.tag) return false;
  if (kind === "payment_received" && cfg.fully_paid_only && !payload.fullyPaid) return false;
  if (kind === "booking_submitted" && cfg.needs_approval && payload.status !== "pending_approval") return false;

  if (kind === "inbound_message") {
    const body = String(payload.body ?? "");
    if (cfg.mode === "keywords" && !replyMatchesAny(body, list("keywords"))) return false;
    if (cfg.mode === "first_message") {
      if (!payload.conversationId) return false;
      const n = await c.query(
        `select count(*)::int as n from messages where conversation_id = $1 and direction = 'in'`,
        [payload.conversationId]
      );
      if (n.rows[0].n > 1) return false;
    }
  }

  if (kind === "patient_created" && list("sources").length) {
    const p = payload.patientId
      ? (await c.query(`select source from patients where id = $1`, [payload.patientId])).rows[0]
      : null;
    if (!p || !list("sources").includes(p.source)) return false;
  }

  const services = list("services");
  const doctors = list("doctors");
  const sources = list("sources");
  const apptKinds = ["appointment_created", "appointment_rescheduled", "appointment_status_changed", "patient_arrived"];
  if (apptKinds.includes(kind) && (services.length || doctors.length || (kind === "appointment_created" && (sources.length || cfg.first_visit)))) {
    if (!payload.appointmentId) return false;
    const a = (
      await c.query(
        `select service_id, doctor_member_id, source, patient_id from appointments where id = $1 and clinic_id = $2`,
        [payload.appointmentId, clinicId]
      )
    ).rows[0];
    if (!a) return false;
    if (services.length && !services.includes(a.service_id)) return false;
    if (doctors.length && !doctors.includes(a.doctor_member_id)) return false;
    if (kind === "appointment_created" && sources.length && !sources.includes(a.source)) return false;
    if (kind === "appointment_created" && cfg.first_visit) {
      const prior = await c.query(
        `select 1 from appointments where patient_id = $1 and clinic_id = $2 and id <> $3
            and status in ('completed', 'confirmed', 'scheduled') limit 1`,
        [a.patient_id, clinicId, payload.appointmentId]
      );
      if (prior.rowCount) return false;
    }
  }
  return true;
}

/** Matches a domain trigger to active automations and starts runs. */
export async function handleTrigger(
  kind: string,
  clinicId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await withSystem(async (c) => {
    // A switched-off module or a deleted clinic starts nothing.
    const live = await c.query(`select 1 from clinics cl where cl.id = $1 and ${licensed("automations")}`, [clinicId]);
    if (!live.rowCount) return;

    const automations = await c.query(
      `select id, trigger_type, trigger_config from automations
       where clinic_id = $1 and active and trigger_type = $2`,
      [clinicId, kind]
    );
    const depth = Number(payload.chainDepth ?? 0) || 0;
    // Only the event's own facts are kept on the run, for {{reply.text}} and
    // the keyword rules — not the whole payload, which can be large.
    const kept: Record<string, unknown> = {};
    for (const k of ["status", "previousStatus", "tag", "source", "fullyPaid", "amount"]) {
      if (payload[k] !== undefined) kept[k] = payload[k];
    }
    if (typeof payload.body === "string") kept.body = payload.body.slice(0, 2000);

    for (const a of automations.rows) {
      const cfg = normalizeTriggerConfig(kind, a.trigger_config);
      if (!(await matchesTrigger(c, clinicId, kind, cfg, payload))) continue;

      const runId = await startRun(
        c,
        clinicId,
        a.id,
        {
          patientId: (payload.patientId as string) ?? null,
          appointmentId: (payload.appointmentId as string) ?? null,
          invoiceId: (payload.invoiceId as string) ?? null,
          conversationId: (payload.conversationId as string) ?? null,
          documentId: (payload.documentId as string) ?? null,
        },
        { chainDepth: depth, payload: kept }
      );
      if (runId) await enqueueAdvance(c, clinicId, runId);
    }
  });
}
