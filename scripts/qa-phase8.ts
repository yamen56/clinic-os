/**
 * QA for Phase 8: AI receptionist — gating, knowledge grounding, availability
 * lookup, booking via the identity rule, escalation, usage tracking, and UI.
 *
 * Runs the real agent code against a local mock of the Messages API
 * (scripts/mock-anthropic.ts), so tool execution and DB writes are genuinely
 * exercised without live API credentials.
 */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { startMockAnthropic } from "./mock-anthropic";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

process.env.ANTHROPIC_API_KEY = "sk-ant-mock-for-qa";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4199";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null>, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await wait(400);
  }
  throw new Error("timed out waiting for condition");
}

async function main() {
  const server = await startMockAnthropic();
  const db = new Client({ connectionString: PG });
  await db.connect();

  // Import the agent AFTER env is set so its client picks up the mock base URL
  const { respondToConversation } = await import("../worker/ai/agent");

  const slug = `qa8-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      /*
        Open every day, Friday included.

        The booking assertion below asks the agent for "بكرا" (tomorrow). With
        Friday closed, tomorrow has no slots one day in seven, the agent correctly
        declines to book, and the suite fails on the day of the week rather than on
        a defect. What is under test here is the agent's tool loop, not the hours.
      */
      `insert into clinics (name, name_ar, slug, address_ar, working_hours)
       values ('QA8 Clinic', 'عيادة النور', $1, 'عمان - الشميساني',
               '{"sun":[["09:00","17:00"]],"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[["09:00","17:00"]]}')
       returning id, timezone`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA8 Owner', 'en') returning id`,
      [`owner-qa8-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'other', true, '{"level":"full"}')`, [clinic.id, owner.id]);
  const docUser = (
    await db.query(`insert into users (email, password_hash, full_name) values ($1, 'x', 'د. ليلى منصور') returning id`, [`doc-qa8-${slug}@test.local`])
  ).rows[0];
  const member = (
    await db.query(`insert into clinic_members (clinic_id, user_id, role, specialty) values ($1, $2, 'doctor', 'طب عام') returning id`, [clinic.id, docUser.id])
  ).rows[0];
  const service = (
    await db.query(
      `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online) values ($1, 'Checkup', 'كشفية', 30, 15, true) returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(`insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3)`, [service.id, member.id, clinic.id]);
  await db.query(`insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 60)`, [clinic.id, slug]);
  // AI on, 24/7 so the test isn't clock-dependent
  await db.query(
    `insert into ai_agents (clinic_id, enabled, agent_name, hours_mode, language_mode, model)
     values ($1, true, 'سارة', 'always', 'match', 'claude-opus-5')`,
    [clinic.id]
  );
  await db.query(
    `insert into ai_knowledge_items (clinic_id, category, title, content)
     values ($1, 'insurance', 'التأمين المقبول', 'نقبل تأمين الشركة الأردنية والمركز الطبي.')`,
    [clinic.id]
  );
  console.log(`✓ fixture clinic ${slug}`);

  async function newConversation(phone: string, text: string) {
    const conv = (
      await db.query(
        `insert into conversations (clinic_id, phone_e164, ai_enabled) values ($1, $2, true) returning id`,
        [clinic.id, phone]
      )
    ).rows[0];
    await db.query(
      `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status)
       values ($1, $2, 'in', 'patient', 'text', $3, 'delivered')`,
      [clinic.id, conv.id, text]
    );
    return conv.id as string;
  }

  async function aiReply(convId: string) {
    return until(async () => {
      const r = await db.query(
        `select body, status from messages where conversation_id = $1 and sender_kind = 'ai' order by created_at desc limit 1`,
        [convId]
      );
      return r.rows[0] ?? null;
    });
  }

  // 1. Knowledge-grounded answer
  const c1 = await newConversation("+962790001111", "كم سعر الكشفية؟");
  await respondToConversation(c1);
  const r1 = await aiReply(c1);
  if (!r1.body.includes("15")) throw new Error(`not grounded in knowledge: ${r1.body}`);
  if (r1.status !== "queued") throw new Error("AI reply not queued for WhatsApp send");
  console.log(`✓ answers from clinic knowledge, queued as AI message: "${r1.body}"`);

  // 2. Booking: availability → book → confirm, with identity rule
  const c2 = await newConversation("+962790002222", "بدي أحجز موعد بكرا");
  await respondToConversation(c2);
  const r2 = await aiReply(c2);
  if (!/تم تأكيد|حجز/.test(r2.body)) throw new Error(`no booking confirmation: ${r2.body}`);
  const appt = await db.query(
    `select a.id, a.status, a.source, a.doctor_member_id, p.full_name, p.phone_e164, p.source as psource
     from appointments a join patients p on p.id = a.patient_id where a.clinic_id = $1`,
    [clinic.id]
  );
  if (appt.rowCount !== 1) throw new Error(`expected 1 appointment, got ${appt.rowCount}`);
  const row = appt.rows[0];
  if (row.source !== "ai_agent" || row.psource !== "ai_agent")
    throw new Error(`wrong source: ${JSON.stringify(row)}`);
  if (row.phone_e164 !== "+962790002222") throw new Error("patient not keyed by conversation phone");
  if (!row.doctor_member_id) throw new Error("no doctor assigned");
  console.log(`✓ checked real availability and booked (${row.full_name}, status ${row.status})`);

  // 3. Booking notified staff + counted usage
  const bookNotif = await db.query(
    `select count(*)::int as n from notifications where clinic_id = $1 and kind = 'ai_booking'`,
    [clinic.id]
  );
  if (bookNotif.rows[0].n < 1) throw new Error("staff not notified of AI booking");
  const usage = await db.query(
    `select messages_out, bookings, input_tokens from ai_usage where clinic_id = $1 and day = current_date`,
    [clinic.id]
  );
  if (usage.rows[0].bookings !== 1 || usage.rows[0].messages_out < 2 || Number(usage.rows[0].input_tokens) === 0)
    throw new Error(`usage not tracked: ${JSON.stringify(usage.rows[0])}`);
  console.log(`✓ staff notified; usage tracked (${usage.rows[0].messages_out} replies, ${usage.rows[0].bookings} booking)`);

  // 4. Emergency → escalate, AI turns itself off on the thread
  const c3 = await newConversation("+962790003333", "في عندي نزيف شديد شو أعمل؟");
  await respondToConversation(c3);
  const conv3 = await until(async () => {
    const r = await db.query(`select flagged, flag_reason, ai_enabled from conversations where id = $1`, [c3]);
    return r.rows[0].flagged ? r.rows[0] : null;
  });
  if (conv3.ai_enabled !== false) throw new Error("AI did not disable itself on escalation");
  const escNotif = await db.query(
    `select count(*)::int as n from notifications where clinic_id = $1 and kind = 'ai_escalation'`,
    [clinic.id]
  );
  if (escNotif.rows[0].n < 1) throw new Error("no escalation notification");
  console.log(`✓ emergency escalated to staff and AI paused: "${conv3.flag_reason}"`);

  // 5. Gating: thread AI off
  const c4 = await newConversation("+962790004444", "مرحبا");
  await db.query(`update conversations set ai_enabled = false where id = $1`, [c4]);
  await respondToConversation(c4);
  await wait(1200);
  let n = await db.query(`select count(*)::int as n from messages where conversation_id = $1 and sender_kind = 'ai'`, [c4]);
  if (n.rows[0].n !== 0) throw new Error("AI replied on a thread with AI off");
  console.log("✓ respects per-thread AI off toggle");

  // 6. Gating: paused after a human reply
  await db.query(`update conversations set ai_enabled = true, ai_paused_until = now() + interval '30 minutes' where id = $1`, [c4]);
  await respondToConversation(c4);
  await wait(1200);
  n = await db.query(`select count(*)::int as n from messages where conversation_id = $1 and sender_kind = 'ai'`, [c4]);
  if (n.rows[0].n !== 0) throw new Error("AI replied while paused after human reply");
  console.log("✓ stays quiet while paused after a staff reply");

  // 7. Gating: agent disabled clinic-wide
  await db.query(`update conversations set ai_paused_until = null where id = $1`, [c4]);
  await db.query(`update ai_agents set enabled = false where clinic_id = $1`, [clinic.id]);
  await respondToConversation(c4);
  await wait(1200);
  n = await db.query(`select count(*)::int as n from messages where conversation_id = $1 and sender_kind = 'ai'`, [c4]);
  if (n.rows[0].n !== 0) throw new Error("AI replied while disabled clinic-wide");
  await db.query(`update ai_agents set enabled = true where clinic_id = $1`, [clinic.id]);
  console.log("✓ respects the clinic-wide off switch");

  /*
    7b. Gating: the agency withdrew the AI module.

    Distinct from the switch above, and the distinction is the money. The
    clinic's own `enabled` flag stays true throughout this check — what changes
    is the licence on the clinics row. If the agent answered anyway, taking the
    module away would hide the settings screen while the tokens carried on being
    spent, which is the opposite of what withdrawing it is for.
  */
  await db.query(`update clinics set features = '{"ai": false}'::jsonb where id = $1`, [clinic.id]);
  await respondToConversation(c4);
  await wait(1200);
  n = await db.query(`select count(*)::int as n from messages where conversation_id = $1 and sender_kind = 'ai'`, [c4]);
  if (n.rows[0].n !== 0) throw new Error("AI replied for a clinic without the AI module");
  await db.query(`update clinics set features = '{}'::jsonb where id = $1`, [clinic.id]);
  console.log("✓ stays silent when the agency has not licensed the AI module");

  // 7c. And a deleted clinic never answers, whatever its own switches say.
  await db.query(`update clinics set deleted_at = now() where id = $1`, [clinic.id]);
  await respondToConversation(c4);
  await wait(1200);
  n = await db.query(`select count(*)::int as n from messages where conversation_id = $1 and sender_kind = 'ai'`, [c4]);
  if (n.rows[0].n !== 0) throw new Error("AI replied for a deleted clinic");
  await db.query(`update clinics set deleted_at = null where id = $1`, [clinic.id]);
  console.log("✓ stays silent for a deleted clinic");

  // 8. Gating: daily cap
  await db.query(`update ai_agents set max_daily_messages = 1 where clinic_id = $1`, [clinic.id]);
  await respondToConversation(c4);
  await wait(1200);
  n = await db.query(`select count(*)::int as n from messages where conversation_id = $1 and sender_kind = 'ai'`, [c4]);
  if (n.rows[0].n !== 0) throw new Error("AI exceeded the daily cap");
  await db.query(`update ai_agents set max_daily_messages = 200 where clinic_id = $1`, [clinic.id]);
  console.log("✓ enforces the daily message cap");

  // 9. UI
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-qa8-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });

  await page.goto(`${BASE}/c/${slug}/ai`);
  await page.waitForSelector("text=AI Agent", { timeout: 15000 });
  await page.waitForSelector("text=Built-in guardrails", { timeout: 10000 });
  console.log("✓ AI settings page renders with guardrails");

  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await page.waitForSelector("text=التأمين المقبول", { timeout: 10000 });
  await page.click("text=Add entry");
  await page.waitForSelector('div[role="dialog"]');
  await page.locator('div[role="dialog"] input').first().fill("موقف السيارات");
  await page.locator('div[role="dialog"] textarea').fill("يوجد موقف مجاني خلف المبنى.");
  await page.locator('div[role="dialog"] button:has-text("Save")').click();
  await page.waitForSelector("text=موقف السيارات", { timeout: 10000 });
  const kn = await db.query(`select count(*)::int as n from ai_knowledge_items where clinic_id = $1`, [clinic.id]);
  if (kn.rows[0].n !== 2) throw new Error("knowledge item not saved");
  console.log("✓ knowledge base entry added through the UI");

  await page.getByRole("tab", { name: /Usage/ }).click();
  await page.waitForSelector("text=Appointments booked", { timeout: 10000 });
  console.log("✓ usage tab shows activity");

  // The new knowledge is actually used by the agent
  const c5 = await newConversation("+962790005555", "كم سعر الكشفية؟");
  await respondToConversation(c5);
  const r5 = await aiReply(c5);
  if (!r5.body.includes("15")) throw new Error("agent lost knowledge grounding after edit");
  console.log("✓ agent still grounded after knowledge edit");

  await page.screenshot({ path: "scripts/qa-shots/phase8-ai.png" });
  await browser.close();

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = any($1::uuid[])`, [[owner.id, docUser.id]]);
  await db.end();
  server.close();

  if (errors.length) {
    console.error("page errors:", errors.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 8 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
