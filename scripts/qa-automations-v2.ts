/**
 * The automations overhaul (migration 0079): the engine against a live worker,
 * and the canvas builder in a real browser.
 *
 * Engine half — every case below is something that went wrong before, or a
 * promise the new engine makes:
 *   - a flow still written as a tree (no edges) runs as it always did
 *   - "wait for a reply" routes "نَعَم", "١" and "2" to their answers, anything
 *     else to "other", silence to "timeout" — and the AI is not woken by an
 *     answer a flow was waiting for
 *   - a switched-off module, an opted-out patient, "only once" and the chain
 *     limit each stop a run before it starts
 *   - an early stop (appointment cancelled) ends a waiting run with nothing sent
 *   - a step that throws marks the run failed instead of leaving it running
 *   - editing a flow keeps waiting runs where they were; removing the step a run
 *     waits on cancels it
 *   - two unknown numbers writing at once are two runs, answered in their own
 *     threads
 *   - a reply can confirm the appointment, through the desk's own status path
 *   - trigger filters (service) and the unanswered-chat sweep
 *
 * Browser half: gallery → template → canvas → save → reload; a flow from
 * scratch; adding a step from a node's "+"; Arabic; a phone's width.
 *
 * Needs the dev stack running (web on :3000, worker, Postgres on 5544).
 */
try { process.loadEnvFile?.(); } catch {}

import { Client, type PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { writeFlowGraph } from "../src/lib/automation/store";
import { validateFlow, treeToGraph, blocking, type FlowEdge, type FlowNode } from "../src/lib/automation/graph";
import { replyHandle, replyMatches } from "../src/lib/automation/match";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30000): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as T;
    await wait(500);
  }
  return null;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const c = db as unknown as PoolClient;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  /* ---------------------------------------------------------------- pure */
  console.log("\nmatching and validation");
  check("نَعَم matches نعم", replyMatches("نَعَم", "نعم"));
  check("١ matches 1", replyMatches("١", "1"));
  check("1 does not match 10:30", !replyMatches("10:30", "1"));
  check("لا does not match لازم", !replyMatches("لازم اغير", "لا"));
  check("reply handle picks answer 2", replyHandle("2 لو سمحت", [{ keywords: ["1"] }, { keywords: ["2"] }]) === "opt:1");
  check("unmatched reply goes to other", replyHandle("ممكن سؤال", [{ keywords: ["1"] }]) === "other");
  {
    const a = randomUUID(), b = randomUUID();
    const nodes: FlowNode[] = [
      { id: a, type: "add_tag", config: { tag: "x" }, position: null, label: "" },
      { id: b, type: "add_tag", config: { tag: "y" }, position: null, label: "" },
    ];
    const cyc = validateFlow({ trigger: "patient_created", triggerConfig: {}, nodes, edges: [{ from: null, handle: "next", to: a }, { from: a, handle: "next", to: b }, { from: b, handle: "next", to: a }] });
    check("a loop is refused", cyc.some((i) => i.code === "cycle") && blocking(cyc));
    const bad = validateFlow({ trigger: "patient_created", triggerConfig: {}, nodes, edges: [{ from: null, handle: "next", to: a }, { from: a, handle: "yes", to: b }] });
    check("an output a step does not have is refused", bad.some((i) => i.code === "bad_edge"));
    const appt = validateFlow({
      trigger: "birthday", triggerConfig: {},
      nodes: [{ id: a, type: "update_appointment", config: { status: "confirmed" }, position: null, label: "" }],
      edges: [{ from: null, handle: "next", to: a }],
    });
    check("an appointment step on a birthday flow is refused", appt.some((i) => i.code === "needs_appointment"));
  }

  /* ---------------------------------------------------------------- fixture */
  const slug = `qa-auto2-${Date.now().toString(36)}`;
  const clinic = await one(
    `insert into clinics (name, name_ar, slug, message_window_start, message_window_end, default_locale)
     values ('QA Auto2', 'عيادة الفحص', $1, '00:00', '23:59', 'ar') returning id`,
    [slug]
  );
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [clinic.id]);
  const owner = await one(
    `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`,
    [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
  );
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  const s1 = await one(`insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Cleaning', 'تنظيف', 30, 20) returning id`, [clinic.id]);
  const s2 = await one(`insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Implant', 'زراعة', 60, 400) returning id`, [clinic.id]);
  let phoneN = 0;
  const patient = async (name: string) =>
    (await one(
      `insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`,
      [clinic.id, name, `+9627900${String(Date.now() % 100000).padStart(5, "0")}${phoneN++}`]
    )).id as string;
  const appointment = async (patientId: string, serviceId: string, hours = 48) =>
    (await one(
      `insert into appointments (clinic_id, patient_id, service_id, starts_at, ends_at, status)
       values ($1, $2, $3, now() + ($4::int * interval '1 hour'), now() + ($4::int * interval '1 hour') + interval '30 min', 'scheduled')
       returning id`,
      [clinic.id, patientId, serviceId, hours]
    )).id as string;
  const trigger = (kind: string, payload: Record<string, unknown>) =>
    db.query(`insert into jobs (clinic_id, kind, payload) values ($1, $2, $3)`, [clinic.id, `trigger:${kind}`, JSON.stringify(payload)]);

  /** A flow written the new way: steps by id, and edges. */
  const flow = async (
    name: string,
    triggerType: string,
    triggerConfig: Record<string, unknown>,
    nodes: { id?: string; type: string; config?: Record<string, unknown> }[],
    edges: (ids: string[]) => FlowEdge[],
    settings: Record<string, unknown> = {}
  ) => {
    const a = await one(
      `insert into automations (clinic_id, name, trigger_type, trigger_config, active, settings, canvas)
       values ($1, $2, $3, $4, true, $5, '{"trigger": null}') returning id`,
      [clinic.id, name, triggerType, JSON.stringify(triggerConfig), JSON.stringify(settings)]
    );
    const full: FlowNode[] = nodes.map((n) => ({ id: n.id ?? randomUUID(), type: n.type, config: n.config ?? {}, position: null, label: "" }));
    await writeFlowGraph(c, clinic.id, a.id, full, edges(full.map((n) => n.id)));
    return { id: a.id as string, ids: full.map((n) => n.id) };
  };
  const runsOf = (automationId: string) => q(`select * from automation_runs where automation_id = $1 order by started_at`, [automationId]);
  const sentBodies = (automationId: string) =>
    q(
      `select m.body, m.conversation_id from messages m join automation_runs r on r.id = m.automation_run_id where r.automation_id = $1 order by m.created_at`,
      [automationId]
    );
  const tagsOf = async (patientId: string) => ((await one(`select tags from patients where id = $1`, [patientId])).tags ?? []) as string[];
  const conversationOf = async (patientId: string) =>
    (await one(`select id from conversations where clinic_id = $1 and patient_id = $2`, [clinic.id, patientId]))?.id as string | undefined;
  const inbound = async (conversationId: string, patientId: string | null, body: string) => {
    await db.query(
      `insert into messages (clinic_id, conversation_id, direction, sender_kind, body, status) values ($1, $2, 'in', 'patient', $3, 'delivered')`,
      [clinic.id, conversationId, body]
    );
    await db.query(
      `update conversations set last_message_at = now(), last_message_direction = 'in' where id = $1`,
      [conversationId]
    );
    await trigger("inbound_message", { conversationId, patientId, body });
  };

  console.log(`\nfixture ${slug}`);

  /* ---------------------------------------------------------------- legacy tree */
  console.log("\na flow still written as a tree");
  {
    const a = await one(
      `insert into automations (clinic_id, name, trigger_type, active) values ($1, 'legacy', 'tag_added', true) returning id`,
      [clinic.id]
    );
    const first = await one(
      `insert into automation_steps (clinic_id, automation_id, sort, step_type, config) values ($1, $2, 0, 'send_whatsapp', $3) returning id`,
      [clinic.id, a.id, JSON.stringify({ message: "legacy first" })]
    );
    const cond = await one(
      `insert into automation_steps (clinic_id, automation_id, sort, step_type, config) values ($1, $2, 1, 'condition', $3) returning id`,
      [clinic.id, a.id, JSON.stringify({ kind: "has_tag", tag: "legacy-vip" })]
    );
    await db.query(
      `insert into automation_steps (clinic_id, automation_id, parent_step_id, branch, sort, step_type, config) values ($1, $2, $3, 'yes', 0, 'send_whatsapp', $4)`,
      [clinic.id, a.id, cond.id, JSON.stringify({ message: "legacy vip" })]
    );
    await db.query(
      `insert into automation_steps (clinic_id, automation_id, sort, step_type, config) values ($1, $2, 2, 'send_whatsapp', $3)`,
      [clinic.id, a.id, JSON.stringify({ message: "legacy last" })]
    );
    void first;
    const p = await patient("Legacy Patient");
    await db.query(`update patients set tags = '{legacy-vip}' where id = $1`, [p]);
    await trigger("tag_added", { patientId: p, tag: "legacy-vip" });
    const bodies = await until(async () => {
      const b = await sentBodies(a.id);
      return b.length >= 3 ? b : null;
    });
    check("runs first, the yes branch, then what follows", JSON.stringify((bodies ?? []).map((b) => b.body)) === JSON.stringify(["legacy first", "legacy vip", "legacy last"]), JSON.stringify((bodies ?? []).map((b) => b.body)));
  }

  /* ---------------------------------------------------------------- wait for a reply */
  console.log("\nwaiting for a reply");
  const reply = await flow(
    "reply",
    "tag_added",
    { tag: "ask" },
    [
      { type: "send_whatsapp", config: { message: "أكد بـ 1 أو 2" } },
      { type: "wait_for_reply", config: { amount: 1, unit: "hours", options: [{ label: "yes", keywords: ["1", "نعم"] }, { label: "no", keywords: ["2"] }] } },
      { type: "add_tag", config: { tag: "r-yes" } },
      { type: "add_tag", config: { tag: "r-no" } },
      { type: "add_tag", config: { tag: "r-other" } },
      { type: "add_tag", config: { tag: "r-timeout" } },
    ],
    (ids) => [
      { from: null, handle: "next", to: ids[0] },
      { from: ids[0], handle: "next", to: ids[1] },
      { from: ids[1], handle: "opt:0", to: ids[2] },
      { from: ids[1], handle: "opt:1", to: ids[3] },
      { from: ids[1], handle: "other", to: ids[4] },
      { from: ids[1], handle: "timeout", to: ids[5] },
    ]
  );
  const rp = { yes: await patient("نعم بالتشكيل"), digit: await patient("رقم هندي"), no: await patient("Two"), other: await patient("Other"), silent: await patient("Silent") };
  for (const p of Object.values(rp)) await trigger("tag_added", { patientId: p, tag: "ask" });
  const allWaiting = await until(async () => {
    const r = await q(`select count(*)::int as n from automation_runs where automation_id = $1 and status = 'waiting' and waiting_for = 'reply'`, [reply.id]);
    return r[0].n >= 5;
  }, 40000);
  check("five runs are waiting for a reply", Boolean(allWaiting));
  const t0 = new Date();
  await inbound((await conversationOf(rp.yes))!, rp.yes, "نَعَم");
  await inbound((await conversationOf(rp.digit))!, rp.digit, "١");
  await inbound((await conversationOf(rp.no))!, rp.no, "2");
  await inbound((await conversationOf(rp.other))!, rp.other, "ممكن أسأل عن السعر؟");
  await until(async () => (await tagsOf(rp.other)).includes("r-other"), 40000);
  check("“نَعَم” takes the first answer", (await tagsOf(rp.yes)).includes("r-yes"));
  check("“١” takes the first answer", (await tagsOf(rp.digit)).includes("r-yes"));
  check("“2” takes the second answer", (await tagsOf(rp.no)).includes("r-no"));
  check("anything else takes “other”", (await tagsOf(rp.other)).includes("r-other"));
  const aiJobs = await q(
    `select count(*)::int as n from jobs where kind = 'ai:respond' and created_at >= $1 and payload->>'conversationId' = any($2::text[])`,
    [t0, [await conversationOf(rp.yes), await conversationOf(rp.no)]]
  );
  check("the AI receptionist is not woken by an awaited answer", aiJobs[0].n === 0, `${aiJobs[0].n} ai jobs`);
  // Silence: bring the timeout forward; the scheduler wakes it on its next tick.
  await db.query(`update automation_runs set wake_at = now() where automation_id = $1 and patient_id = $2 and status = 'waiting'`, [reply.id, rp.silent]);

  /* ---------------------------------------------------------------- what stops a run starting */
  console.log("\nwhat stops a run before it starts");
  {
    const simple = await flow("simple", "tag_added", { tag: "go" }, [{ type: "add_tag", config: { tag: "went" } }], (ids) => [{ from: null, handle: "next", to: ids[0] }]);
    const muted = await patient("Muted");
    await db.query(`update patients set automation_opt_out = true where id = $1`, [muted]);
    await trigger("tag_added", { patientId: muted, tag: "go" });

    const once = await flow("once", "tag_added", { tag: "once" }, [{ type: "add_tag", config: { tag: "once-done" } }], (ids) => [{ from: null, handle: "next", to: ids[0] }], { reentry: "once" });
    const op = await patient("Once");
    await trigger("tag_added", { patientId: op, tag: "once" });
    await until(async () => (await runsOf(once.id)).some((r) => r.status === "completed"));
    await trigger("tag_added", { patientId: op, tag: "once" });

    const loop = await flow(
      "loop",
      "tag_added",
      { tag: "loop" },
      [{ type: "remove_tag", config: { tag: "loop" } }, { type: "add_tag", config: { tag: "loop" } }],
      (ids) => [{ from: null, handle: "next", to: ids[0] }, { from: ids[0], handle: "next", to: ids[1] }]
    );
    const lp = await patient("Loop");
    await db.query(`update patients set tags = '{loop}' where id = $1`, [lp]);
    await trigger("tag_added", { patientId: lp, tag: "loop" });

    await wait(8000);
    check("an opted-out patient starts nothing", (await q(`select 1 from automation_runs where automation_id = $1 and patient_id = $2`, [simple.id, muted])).length === 0);
    check("“only once” starts once", (await runsOf(once.id)).filter((r) => r.patient_id === op).length === 1);
    const loops = (await runsOf(loop.id)).length;
    check("two flows feeding each other stop at the chain limit", loops >= 2 && loops <= 4, `${loops} runs`);

    // A clinic without the module.
    const off = await one(`insert into clinics (name, slug, features) values ('QA off', $1, '{"automations": false}') returning id`, [`${slug}-off`]);
    const offAuto = await one(`insert into automations (clinic_id, name, trigger_type, active, canvas) values ($1, 'off', 'tag_added', true, '{"trigger": null}') returning id`, [off.id]);
    const offP = await one(`insert into patients (clinic_id, full_name, phone_e164) values ($1, 'Off', '+962790000999') returning id`, [off.id]);
    await db.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:tag_added', $2)`, [off.id, JSON.stringify({ patientId: offP.id, tag: "x" })]);
    await wait(4000);
    check("a clinic without the automations module starts nothing", (await q(`select 1 from automation_runs where automation_id = $1`, [offAuto.id])).length === 0);
    await db.query(`delete from clinics where id = $1`, [off.id]);
  }

  /* ---------------------------------------------------------------- early stop, failure */
  console.log("\nstopping early, and failing loudly");
  const exitFlow = await flow(
    "exit",
    "appointment_created",
    {},
    [{ type: "wait", config: { mode: "duration", amount: 2, unit: "hours" } }, { type: "send_whatsapp", config: { message: "should never send" } }],
    (ids) => [{ from: null, handle: "next", to: ids[0] }, { from: ids[0], handle: "next", to: ids[1] }],
    { exit_on: ["appointment_cancelled"] }
  );
  const ep = await patient("Exit");
  const ea = await appointment(ep, s1.id);
  await trigger("appointment_created", { appointmentId: ea, patientId: ep });
  await until(async () => (await runsOf(exitFlow.id)).some((r) => r.status === "waiting"));
  await db.query(`update appointments set status = 'cancelled' where id = $1`, [ea]);
  await db.query(`update automation_runs set wake_at = now() where automation_id = $1 and status = 'waiting'`, [exitFlow.id]);

  const failFlow = await flow(
    "fail",
    "tag_added",
    { tag: "fail" },
    [{ type: "goto_automation", config: { automation_id: "not-a-uuid" } }, { type: "add_tag", config: { tag: "after-fail" } }],
    (ids) => [{ from: null, handle: "next", to: ids[0] }, { from: ids[0], handle: "next", to: ids[1] }]
  );
  const fp = await patient("Fail");
  await trigger("tag_added", { patientId: fp, tag: "fail" });
  const failed = await until(async () => (await runsOf(failFlow.id)).find((r) => r.status === "failed"), 30000);
  check("a step that throws marks the run failed", Boolean(failed), failed ? String(failed.error).slice(0, 60) : "still running");
  check("and the steps after it do not run", !(await tagsOf(fp)).includes("after-fail"));

  /* ---------------------------------------------------------------- editing a running flow */
  console.log("\nediting a flow while runs wait in it");
  const edit = await flow(
    "edit",
    "tag_added",
    { tag: "edit" },
    [
      { type: "send_whatsapp", config: { message: "edit first" } },
      { type: "wait", config: { mode: "duration", amount: 3, unit: "hours" } },
      { type: "send_whatsapp", config: { message: "edit after v1" } },
    ],
    (ids) => [{ from: null, handle: "next", to: ids[0] }, { from: ids[0], handle: "next", to: ids[1] }, { from: ids[1], handle: "next", to: ids[2] }]
  );
  const xp = await patient("Edit Keep");
  const yp = await patient("Edit Drop");
  await trigger("tag_added", { patientId: xp, tag: "edit" });
  await until(async () => (await runsOf(edit.id)).some((r) => r.status === "waiting" && r.patient_id === xp));
  // Same ids, new wording after the wait: the run must carry on, not start again.
  await writeFlowGraph(c, clinic.id, edit.id, [
    { id: edit.ids[0], type: "send_whatsapp", config: { message: "edit first" }, position: null, label: "" },
    { id: edit.ids[1], type: "wait", config: { mode: "duration", amount: 3, unit: "hours" }, position: null, label: "" },
    { id: edit.ids[2], type: "send_whatsapp", config: { message: "edit after v2" }, position: null, label: "" },
  ], [{ from: null, handle: "next", to: edit.ids[0] }, { from: edit.ids[0], handle: "next", to: edit.ids[1] }, { from: edit.ids[1], handle: "next", to: edit.ids[2] }]);
  await db.query(`update automation_runs set wake_at = now() where automation_id = $1 and patient_id = $2 and status = 'waiting'`, [edit.id, xp]);

  await trigger("tag_added", { patientId: yp, tag: "edit" });
  await until(async () => (await runsOf(edit.id)).some((r) => r.status === "waiting" && r.patient_id === yp));

  /* ---------------------------------------------------------------- unknown numbers */
  console.log("\nunknown numbers, filters, confirming by reply");
  const auto = await flow("autoreply", "inbound_message", { mode: "any", keywords: [] }, [{ type: "send_whatsapp", config: { message: "سنرد عليك قريباً" } }], (ids) => [{ from: null, handle: "next", to: ids[0] }]);
  const cv1 = await one(`insert into conversations (clinic_id, phone_e164) values ($1, '+962781110001') returning id`, [clinic.id]);
  const cv2 = await one(`insert into conversations (clinic_id, phone_e164) values ($1, '+962781110002') returning id`, [clinic.id]);
  await inbound(cv1.id, null, "مرحبا");
  await inbound(cv2.id, null, "مرحبا");

  const filtered = await flow("svc", "appointment_created", { services: [s2.id] }, [{ type: "add_tag", config: { tag: "implant-flow" } }], (ids) => [{ from: null, handle: "next", to: ids[0] }]);
  const fp1 = await patient("Cleaning Only");
  const fp2 = await patient("Implant Patient");
  await trigger("appointment_created", { appointmentId: await appointment(fp1, s1.id), patientId: fp1 });
  await trigger("appointment_created", { appointmentId: await appointment(fp2, s2.id), patientId: fp2 });

  const confirm = await flow(
    "confirm",
    "tag_added",
    { tag: "confirm-me" },
    [
      { type: "send_whatsapp", config: { message: "أرسل 1 للتأكيد" } },
      { type: "wait_for_reply", config: { amount: 1, unit: "hours", options: [{ label: "ok", keywords: ["1"] }] } },
      { type: "update_appointment", config: { status: "confirmed" } },
    ],
    (ids) => [{ from: null, handle: "next", to: ids[0] }, { from: ids[0], handle: "next", to: ids[1] }, { from: ids[1], handle: "opt:0", to: ids[2] }]
  );
  // Started with an appointment in context, the way a reminder would be.
  const cp = await patient("Confirm By Reply");
  const ca = await appointment(cp, s1.id);
  await db.query(
    `insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:tag_added', $2)`,
    [clinic.id, JSON.stringify({ patientId: cp, tag: "confirm-me", appointmentId: ca })]
  );
  await until(async () => (await runsOf(confirm.id)).some((r) => r.status === "waiting"));
  await inbound((await conversationOf(cp))!, cp, "1");

  const unanswered = await flow("unanswered", "conversation_unanswered", { minutes: 5 }, [{ type: "flag_conversation", config: { reason: "qa waiting" } }], (ids) => [{ from: null, handle: "next", to: ids[0] }]);
  const cv3 = await one(
    `insert into conversations (clinic_id, phone_e164, last_message_at, last_message_direction, status)
     values ($1, '+962781110003', now() - interval '6 minutes', 'in', 'open') returning id`,
    [clinic.id]
  );

  // Everything clock-driven above needs the scheduler's next tick.
  console.log("  … waiting for the scheduler's tick");
  const ticked = await until(async () => {
    const silent = (await tagsOf(rp.silent)).includes("r-timeout");
    const exited = (await runsOf(exitFlow.id)).some((r) => r.status === "completed");
    const edited = (await sentBodies(edit.id)).some((b) => b.body === "edit after v2");
    const flagged = (await one(`select flagged from conversations where id = $1`, [cv3.id])).flagged;
    return silent && exited && edited && flagged;
  }, 150000);
  check("the scheduler's tick came", Boolean(ticked));
  check("silence takes “timeout”", (await tagsOf(rp.silent)).includes("r-timeout"));
  const exitLogs = await q(`select l.detail from automation_run_logs l join automation_runs r on r.id = l.run_id where r.automation_id = $1`, [exitFlow.id]);
  check("a cancelled appointment stops its waiting reminder", exitLogs.some((l) => l.detail?.exited === "appointment_cancelled"));
  check("and nothing is sent", (await sentBodies(exitFlow.id)).length === 0);
  const editBodies = (await sentBodies(edit.id)).filter((b) => b.body.startsWith("edit"));
  check("an edited flow carries on where its run was waiting", editBodies.some((b) => b.body === "edit after v2"));
  check("without sending its first message again", editBodies.filter((b) => b.body === "edit first").length === 2, editBodies.map((b) => b.body).join(" | "));
  check("the unanswered chat was picked up", Boolean((await one(`select flagged from conversations where id = $1`, [cv3.id])).flagged));

  // Removing the step a run waits on cancels it rather than restarting it.
  await writeFlowGraph(c, clinic.id, edit.id, [
    { id: edit.ids[0], type: "send_whatsapp", config: { message: "edit first" }, position: null, label: "" },
  ], [{ from: null, handle: "next", to: edit.ids[0] }]);
  const dropped = await one(`select status, error from automation_runs where automation_id = $1 and patient_id = $2`, [edit.id, yp]);
  check("removing the step a run waits on stops that run", dropped?.status === "cancelled" && dropped?.error === "step_removed", JSON.stringify(dropped));

  const autoBodies = await sentBodies(auto.id);
  check("two unknown numbers are two runs", (await runsOf(auto.id)).length === 2, `${(await runsOf(auto.id)).length}`);
  check("each answered in its own thread", new Set(autoBodies.map((b) => b.conversation_id)).size === 2 && autoBodies.every((b) => [cv1.id, cv2.id].includes(b.conversation_id)));
  check("a service filter skips other services", !(await tagsOf(fp1)).includes("implant-flow"));
  check("and keeps its own", (await tagsOf(fp2)).includes("implant-flow"));
  const confirmed = await until(async () => (await one(`select status from appointments where id = $1`, [ca])).status === "confirmed", 30000);
  check("a “1” confirms the appointment", Boolean(confirmed));
  const statusJob = await q(
    `select payload from jobs where clinic_id = $1 and kind = 'trigger:appointment_status_changed' and payload->>'appointmentId' = $2`,
    [clinic.id, ca]
  );
  check("through the desk's own status path, chain depth carried", statusJob.length === 1 && Number(statusJob[0].payload.chainDepth) >= 1);

  /* ---------------------------------------------------------------- browser */
  console.log("\nthe builder");
  const browser = await chromium.launch();
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000 });

  await page.goto(`${BASE}/c/${slug}/automations`, { timeout: 90000 });
  await page.getByRole("button", { name: "New automation" }).first().click();
  await page.waitForSelector('[data-template="reminder_24h"]', { timeout: 30000 });
  check("the gallery opens with templates", (await page.locator("[data-template]").count()) > 10);
  await page.click('[data-template="reminder_24h"]');
  await page.waitForURL(/automations\/new\?template=/, { timeout: 60000 });
  await page.waitForSelector(".react-flow__node-step", { timeout: 60000 });
  const templateNodes = await page.locator(".react-flow__node-step").count();
  check("the template is drawn on the canvas", templateNodes >= 8, `${templateNodes} steps`);
  check("its name is filled in", (await page.inputValue('input[aria-label="Name this automation"]')).length > 3);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/automations\/[0-9a-f-]{36}$/, { timeout: 60000 });
  const savedId = page.url().split("/").pop()!;
  const counts = await one(
    `select (select count(*)::int from automation_steps where automation_id = $1) as steps,
            (select count(*)::int from automation_edges where automation_id = $1) as edges`,
    [savedId]
  );
  check("saving writes its steps and edges", counts.steps === templateNodes && counts.edges >= templateNodes, JSON.stringify(counts));
  await page.reload();
  await page.waitForSelector(".react-flow__node-step", { timeout: 60000 });
  check("reloaded, the same flow is drawn", (await page.locator(".react-flow__node-step").count()) === templateNodes);

  // A step added from a node's own "+".
  await page.locator('button[aria-label="Add step"]').first().click();
  await page.waitForSelector('[data-pick="add_tag"]', { timeout: 15000 });
  await page.click('[data-pick="add_tag"]');
  await page.locator("[data-inspector] input").first().fill("qa-canvas-tag");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await until(async () => (await one(`select count(*)::int as n from automation_steps where automation_id = $1`, [savedId])).n === templateNodes + 1, 20000);
  const added = await one(`select config from automation_steps where automation_id = $1 and step_type = 'add_tag' and config->>'tag' = 'qa-canvas-tag'`, [savedId]);
  check("a step added from a node's “+” is saved, connected", Boolean(added) && (await one(`select count(*)::int as n from automation_edges e join automation_steps s on s.id = e.to_step_id where e.automation_id = $1 and s.config->>'tag' = 'qa-canvas-tag'`, [savedId])).n === 1);

  // From scratch: the trigger question opens by itself.
  await page.goto(`${BASE}/c/${slug}/automations/new`);
  await page.waitForSelector('[data-pick="patient_created"]', { timeout: 60000 });
  await page.click('[data-pick="patient_created"]');
  await page.getByRole("button", { name: "Add the first step" }).click();
  await page.click('[data-pick="send_whatsapp"]');
  await page.locator("[data-inspector] textarea").first().fill("أهلاً {{patient.first_name}}");
  await page.fill('input[aria-label="Name this automation"]', "QA scratch");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/automations\/[0-9a-f-]{36}$/, { timeout: 60000 });
  const scratch = await one(
    `select a.trigger_type, (select count(*)::int from automation_edges e where e.automation_id = a.id) as edges
       from automations a where a.clinic_id = $1 and a.name = 'QA scratch'`,
    [clinic.id]
  );
  check("a flow from scratch is saved with its trigger and edge", scratch?.trigger_type === "patient_created" && scratch.edges === 1, JSON.stringify(scratch));

  // Arabic, read the way a person sees it.
  await db.query(`update users set locale = 'ar' where id = $1`, [owner.id]);
  await page.context().addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);
  await page.goto(`${BASE}/c/${slug}/automations/${savedId}`);
  await page.waitForSelector(".react-flow__node-step", { timeout: 60000 });
  const arText = await page.evaluate("document.body.innerText");
  check("the builder reads in Arabic", String(arText).includes("المسار") && String(arText).includes("انتظار الرد"));

  // A phone: nothing scrolls sideways.
  const phone = await browser.newContext({ viewport: { width: 375, height: 760 }, storageState: await ctx.storageState() });
  const pp = await phone.newPage();
  pp.on("pageerror", (e) => errors.push(e.message));
  for (const path of [`/c/${slug}/automations`, `/c/${slug}/automations/${savedId}`]) {
    await pp.goto(`${BASE}${path}`, { timeout: 90000 });
    await pp.waitForLoadState("networkidle");
    await wait(800);
    const over = await pp.evaluate("document.documentElement.scrollWidth - window.innerWidth");
    check(`${path.endsWith(savedId) ? "the builder" : "the list"} fits a phone`, Number(over) <= 1, `${over}px over`);
  }
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();

  /* ---------------------------------------------------------------- tidy */
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e);
  process.exit(1);
});

void treeToGraph;
