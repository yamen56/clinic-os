/** QA for Phase 7: automation engine — triggers, steps, branching, idempotency, windows, logs. */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null>, ms = 25000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await wait(500);
  }
  throw new Error("timed out waiting for condition");
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qa7-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, message_window_start, message_window_end) values ('QA7 Clinic', $1, '00:00', '23:59') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA7 Owner', 'en') returning id`,
      [`owner-qa7-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'other', true, '{"level":"full"}')`, [clinic.id, owner.id]);
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'سامي الحوراني', '+962791234567', 'staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  const service = (
    await db.query(
      `insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Checkup', 'كشفية', 30, 20) returning id`,
      [clinic.id]
    )
  ).rows[0];
  console.log(`✓ fixture clinic ${slug}`);

  // 1. Automation with variables fires on appointment_created
  const auto = (
    await db.query(
      `insert into automations (clinic_id, name, trigger_type, active) values ($1, 'Confirm', 'appointment_created', true) returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(
    `insert into automation_steps (clinic_id, automation_id, sort, step_type, config)
     values ($1, $2, 0, 'send_whatsapp', $3)`,
    [
      clinic.id, auto.id,
      JSON.stringify({ message: "مرحباً {{patient.first_name}}، موعدك {{appointment.date}} الساعة {{appointment.time}} في {{clinic.name}} — {{appointment.service}}" }),
    ]
  );

  const appt = (
    await db.query(
      `insert into appointments (clinic_id, patient_id, service_id, starts_at, ends_at, status)
       values ($1, $2, $3, now() + interval '2 days', now() + interval '2 days' + interval '30 min', 'scheduled')
       returning id`,
      [clinic.id, patient.id, service.id]
    )
  ).rows[0];
  await db.query(
    `insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:appointment_created', $2)`,
    [clinic.id, JSON.stringify({ appointmentId: appt.id, patientId: patient.id })]
  );

  const msg = await until(async () => {
    const r = await db.query(
      `select body, sender_kind, status, automation_run_id from messages
       where clinic_id = $1 and sender_kind = 'automation' limit 1`,
      [clinic.id]
    );
    return r.rows[0] ?? null;
  });
  if (!msg.body.includes("سامي") || !msg.body.includes("QA7 Clinic") || !msg.body.includes("كشفية"))
    throw new Error(`template not rendered: ${msg.body}`);
  if (msg.body.includes("{{")) throw new Error("unreplaced variables remain");
  console.log(`✓ trigger fired, variables rendered: "${msg.body.slice(0, 60)}…"`);

  // 2. Run completed and logged
  const run = await until(async () => {
    const r = await db.query(
      `select r.id, r.status, (select count(*)::int from automation_run_logs l where l.run_id = r.id) as logs
       from automation_runs r where r.automation_id = $1`,
      [auto.id]
    );
    return r.rows[0]?.status === "completed" ? r.rows[0] : null;
  });
  if (run.logs < 1) throw new Error("no step logs recorded");
  console.log(`✓ run completed with ${run.logs} step log(s)`);

  // 3. Idempotency: replaying the same trigger must not duplicate the message
  await db.query(
    `insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:appointment_created', $2)`,
    [clinic.id, JSON.stringify({ appointmentId: appt.id, patientId: patient.id })]
  );
  await wait(4000);
  const dupCount = await db.query(
    `select count(*)::int as n from messages where clinic_id = $1 and sender_kind = 'automation'`,
    [clinic.id]
  );
  if (dupCount.rows[0].n !== 1) throw new Error(`duplicate messages sent: ${dupCount.rows[0].n}`);
  console.log("✓ replayed trigger did not duplicate the message");

  // 4. Branching: condition (has_tag) routes to the right branch
  const auto2 = (
    await db.query(
      `insert into automations (clinic_id, name, trigger_type, trigger_config, active)
       values ($1, 'Branch', 'tag_added', '{"tag":"vip"}', true) returning id`,
      [clinic.id]
    )
  ).rows[0];
  const cond = (
    await db.query(
      `insert into automation_steps (clinic_id, automation_id, sort, step_type, config)
       values ($1, $2, 0, 'condition', '{"kind":"has_tag","tag":"vip"}') returning id`,
      [clinic.id, auto2.id]
    )
  ).rows[0];
  await db.query(
    `insert into automation_steps (clinic_id, automation_id, parent_step_id, branch, sort, step_type, config)
     values ($1, $2, $3, 'yes', 0, 'add_tag', '{"tag":"branch-yes"}'),
            ($1, $2, $3, 'no', 0, 'add_tag', '{"tag":"branch-no"}')`,
    [clinic.id, auto2.id, cond.id]
  );
  await db.query(`update patients set tags = array['vip'] where id = $1`, [patient.id]);
  await db.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:tag_added', $2)`, [
    clinic.id,
    JSON.stringify({ patientId: patient.id, tag: "vip" }),
  ]);
  const tags = await until(async () => {
    const r = await db.query(`select tags from patients where id = $1`, [patient.id]);
    return r.rows[0].tags.includes("branch-yes") || r.rows[0].tags.includes("branch-no")
      ? r.rows[0].tags
      : null;
  });
  if (!tags.includes("branch-yes") || tags.includes("branch-no"))
    throw new Error(`wrong branch taken: ${JSON.stringify(tags)}`);
  console.log("✓ condition took the 'yes' branch correctly");

  // 5. Wait step parks the run, scheduler wakes it
  const auto3 = (
    await db.query(
      `insert into automations (clinic_id, name, trigger_type, active) values ($1, 'Waiter', 'patient_created', true) returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(
    `insert into automation_steps (clinic_id, automation_id, sort, step_type, config)
     values ($1, $2, 0, 'wait', '{"minutes":0}'), ($1, $2, 1, 'add_tag', '{"tag":"after-wait"}')`,
    [clinic.id, auto3.id]
  );
  const p2 = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'ليث', '+962795550001', 'staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:patient_created', $2)`, [
    clinic.id,
    JSON.stringify({ patientId: p2.id }),
  ]);
  await until(async () => {
    const r = await db.query(`select status from automation_runs where automation_id = $1`, [auto3.id]);
    return r.rows[0]?.status === "waiting" ? r.rows[0] : null;
  });
  console.log("✓ wait step parked the run in 'waiting'");
  await until(async () => {
    const r = await db.query(`select tags from patients where id = $1`, [p2.id]);
    return r.rows[0].tags.includes("after-wait") ? r.rows[0] : null;
  }, 90000);
  console.log("✓ scheduler woke the run and finished the remaining steps");

  // 6. Sending window defers out-of-hours messages
  await db.query(
    `update clinics set message_window_start = '09:00', message_window_end = '09:01' where id = $1`,
    [clinic.id]
  );
  const auto4 = (
    await db.query(
      `insert into automations (clinic_id, name, trigger_type, active) values ($1, 'Windowed', 'invoice_sent', true) returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(
    `insert into automation_steps (clinic_id, automation_id, sort, step_type, config)
     values ($1, $2, 0, 'send_whatsapp', '{"message":"window test"}')`,
    [clinic.id, auto4.id]
  );
  await db.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:invoice_sent', $2)`, [
    clinic.id,
    JSON.stringify({ patientId: patient.id }),
  ]);
  const windowed = await until(async () => {
    const r = await db.query(
      `select scheduled_at from messages where clinic_id = $1 and body = 'window test'`,
      [clinic.id]
    );
    return r.rows[0] ?? null;
  });
  if (new Date(windowed.scheduled_at).getTime() <= Date.now() + 60_000)
    throw new Error("out-of-window message was not deferred");
  console.log("✓ out-of-window message deferred to the next window");

  // 7. UI: builder renders, toggle works, history shows runs
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-qa7-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });

  await page.goto(`${BASE}/c/${slug}/automations`);
  await page.waitForSelector("text=Confirm", { timeout: 15000 });
  console.log("✓ automations list renders");

  await page.click("text=Confirm");
  await page.waitForSelector("text=When this happens", { timeout: 15000 });
  await page.waitForSelector("text=Send WhatsApp message", { timeout: 10000 });
  console.log("✓ flow builder loads trigger + steps");

  // add a step and save
  await page.click("text=Add step");
  await page.click("button:has-text('Add tag')");
  await page.locator('input').last().fill("qa-added-step");
  await page.click("button:has-text('Save')");
  await page.waitForSelector("text=Automation saved", { timeout: 15000 });
  const stepCount = await db.query(
    `select count(*)::int as n from automation_steps where automation_id = $1`,
    [auto.id]
  );
  if (stepCount.rows[0].n !== 2) throw new Error(`step not persisted: ${stepCount.rows[0].n}`);
  console.log("✓ builder saved a new step");

  await page.goto(`${BASE}/c/${slug}/automations/${auto.id}?tab=history`);
  await page.waitForSelector("text=Done", { timeout: 15000 });
  console.log("✓ run history shows completed run with step results");

  await page.screenshot({ path: "scripts/qa-shots/phase7-builder.png" });
  await browser.close();

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  if (errors.length) {
    console.error("page errors:", errors.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 7 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
