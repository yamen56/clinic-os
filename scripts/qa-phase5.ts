/** Browser QA for Phase 5: inbound threading, inbox UI, composer, AI toggle, QR connect flow. */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const WORKER = "http://localhost:4020";
try {
  process.loadEnvFile?.();
} catch {}
// Must match the running worker; falls back to the dev default.
const SECRET = process.env.INTERNAL_API_SECRET || "dev-internal-secret-change-in-production";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

async function simulateInbound(clinicId: string, phone: string, name: string, body: string) {
  const res = await fetch(`${WORKER}/simulate-inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": SECRET },
    body: JSON.stringify({ clinicId, phone, name, body }),
  });
  if (!res.ok) throw new Error(`simulate-inbound failed: ${res.status}`);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qa5-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(`insert into clinics (name, slug) values ('QA5 Clinic', $1) returning id`, [slug])
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA5 Owner', 'en') returning id`,
      [`owner-qa5-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'other', true, '{"level":"full"}')`, [
    clinic.id, owner.id,
  ]);
  // Pre-existing patient for the identity-rule check
  await db.query(
    `insert into patients (clinic_id, full_name, phone_e164, source, status) values ($1, 'أم كلثوم الموجودة', '+962779998877', 'staff', 'active')`,
    [clinic.id]
  );
  console.log(`✓ fixture clinic ${slug}`);

  /*
    1. Inbound from an unknown number → a conversation, and no patient file.
    Anyone can message a clinic; the patient list is for the people staff
    added, the AI booked, or who came through the booking link.
  */
  await simulateInbound(clinic.id, "0788881122", "Abu Salem", "السلام عليكم، بدي أحجز موعد");
  const p1 = await db.query(
    `select 1 from patients where clinic_id = $1 and phone_e164 = '+962788881122'`,
    [clinic.id]
  );
  if (p1.rowCount !== 0)
    throw new Error("a WhatsApp message must not create a patient file");
  const c1 = await db.query(
    `select patient_id, whatsapp_name from conversations where clinic_id = $1 and phone_e164 = '+962788881122'`,
    [clinic.id]
  );
  if (c1.rowCount !== 1 || c1.rows[0].patient_id !== null)
    throw new Error(`conversation not created unlinked: ${JSON.stringify(c1.rows)}`);
  if (c1.rows[0].whatsapp_name !== "Abu Salem")
    throw new Error("the thread must remember the sender's WhatsApp name itself");
  console.log("✓ unknown number → conversation only, no patient file");

  // 2. Inbound from the existing patient's number (different format) → attaches, stays active
  await simulateInbound(clinic.id, "0779998877", "Umm K", "مرحبا");
  const p2 = await db.query(
    `select count(*)::int as n from patients where clinic_id = $1 and (phone_e164 = '+962779998877' or whatsapp_name = 'Umm K')`,
    [clinic.id]
  );
  if (p2.rows[0].n !== 1) throw new Error("identity rule violated: duplicate created for existing patient");
  const conv2 = await db.query(
    `select cv.patient_id, p.status from conversations cv join patients p on p.id = cv.patient_id
     where cv.clinic_id = $1 and cv.phone_e164 = '+962779998877'`,
    [clinic.id]
  );
  if (conv2.rows[0].status !== "active") throw new Error("existing patient demoted to lead");
  console.log("✓ inbound attaches to existing patient by phone");


  // 3. Inbox UI
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-qa5-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
  await page.goto(`${BASE}/c/${slug}/conversations`);
  await page.waitForSelector("text=Abu Salem", { timeout: 15000 });
  console.log("✓ inbox lists the WhatsApp thread");

  // open thread → message visible, unread cleared
  await page.click("text=Abu Salem");
  await page.waitForSelector("text=بدي أحجز موعد", { timeout: 10000 });
  console.log("✓ thread shows inbound message");

  // 4. Reply from composer → queued message with staff sender + AI pause
  await page.fill("textarea", "أهلاً وسهلاً! متى يناسبك الموعد؟");
  await page.click('button[aria-label="Send"]');
  let sent: { rows: { status: string; sender_kind: string; ai_paused_until: string | null }[] } = { rows: [] };
  for (let i = 0; i < 20 && sent.rows.length === 0; i++) {
    sent = await db.query(
      `select m.status, m.sender_kind, cv.ai_paused_until from messages m
       join conversations cv on cv.id = m.conversation_id
       where m.clinic_id = $1 and m.direction = 'out' order by m.created_at desc limit 1`,
      [clinic.id]
    );
    if (sent.rows.length === 0) await new Promise((r) => setTimeout(r, 500));
  }
  if (sent.rows.length === 0) throw new Error("reply message never reached the database");
  if (sent.rows[0].sender_kind !== "staff" || !["queued", "sending"].includes(sent.rows[0].status))
    throw new Error(`reply not queued as staff: ${JSON.stringify(sent.rows[0])}`);
  if (!sent.rows[0].ai_paused_until) throw new Error("AI not paused after manual reply");
  console.log("✓ staff reply queued for worker; AI auto-paused on thread");

  // 5. Realtime: new inbound appears without reload
  await simulateInbound(clinic.id, "0788881122", "Abu Salem", "شو أوقاتكم اليوم؟");
  await page.waitForSelector("text=شو أوقاتكم اليوم؟", { timeout: 15000 });
  console.log("✓ realtime: inbound message streamed into open thread");

  // 6. AI toggle + assign
  await page.locator('button[role="switch"]').first().click();
  await page.waitForTimeout(800);
  const ai = await db.query(
    `select ai_enabled from conversations where clinic_id = $1 and phone_e164 = '+962788881122'`,
    [clinic.id]
  );
  if (ai.rows[0].ai_enabled !== false) throw new Error("AI toggle failed");
  console.log("✓ AI off toggle persists");
  await page.click("text=Assign to me");
  await page.waitForSelector("text=Mine", { timeout: 8000 });
  console.log("✓ thread assigned to me");

  /*
    7. Promoting a thread. An unknown number gets a conversation and nothing
    more, so this is the step that decides somebody is a patient — and the
    only way one enters the list from WhatsApp.
  */
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByRole("button", { name: /create patient file/i }).click();
  await page.waitForSelector("text=Open file", { timeout: 20000 });
  const promoted = await db.query(
    `select p.source, p.status, p.full_name, p.phone_e164 from patients p
      join conversations cv on cv.patient_id = p.id
     where cv.clinic_id = $1 and cv.phone_e164 = '+962788881122'`,
    [clinic.id]
  );
  if (promoted.rowCount !== 1 || promoted.rows[0].source !== "staff")
    throw new Error(`promotion did not create a staff patient: ${JSON.stringify(promoted.rows)}`);
  if (promoted.rows[0].full_name !== "Abu Salem")
    throw new Error(`the WhatsApp name should become the file name: ${promoted.rows[0].full_name}`);
  console.log("✓ staff can turn a thread into a patient file");
  if (promoted.rows[0].phone_e164 !== "+962788881122")
    throw new Error(`the real number should land on the file: ${promoted.rows[0].phone_e164}`);

  /*
    8. The same, for a chat WhatsApp addresses by identity rather than number.
    `phone_e164` is holding a LID standing in for a number, and copying it onto
    a patient file writes a fifteen-digit thing that looks like a phone number,
    cannot be dialled, and turns up in the patient list as "a strange number".
  */
  const lid = "947716245331902";
  await db.query(
    `insert into conversations (clinic_id, phone_e164, wa_jid, wa_lid, identifier_kind,
                                whatsapp_name, last_message_at, last_message_preview)
     values ($1, $2, $3, $4, 'lid', 'Nadia', now(), 'مرحبا')`,
    [clinic.id, `+${lid}`, `${lid}@lid`, lid]
  );
  await page.goto(`${BASE}/c/${slug}/conversations`);
  await page.waitForLoadState("networkidle");
  await page.click("text=Nadia");
  await page.getByRole("button", { name: /create patient file/i }).click();
  await page.waitForSelector("text=Open file", { timeout: 20000 });

  const fromLid = await db.query(
    `select p.full_name, p.phone_e164 from patients p
      join conversations cv on cv.patient_id = p.id
     where cv.clinic_id = $1 and cv.wa_lid = $2`,
    [clinic.id, lid]
  );
  if (fromLid.rowCount !== 1)
    throw new Error("promoting a LID thread did not create a file");
  if (fromLid.rows[0].phone_e164 !== null)
    throw new Error(`a LID must not become a phone number: ${fromLid.rows[0].phone_e164}`);
  if (fromLid.rows[0].full_name !== "Nadia")
    throw new Error(`the WhatsApp name should name the file: ${fromLid.rows[0].full_name}`);
  console.log("✓ promoting a LID thread leaves the phone blank, not a fake number");

  // 7. WhatsApp settings: connect → QR appears (live Baileys against WA servers)
  await page.goto(`${BASE}/c/${slug}/settings/whatsapp`);
  await page.waitForSelector("text=Connect WhatsApp", { timeout: 15000 });
  await page.click("text=Connect WhatsApp");
  try {
    await page.waitForSelector('img[alt="WhatsApp QR"]', { timeout: 45000 });
    console.log("✓ QR code generated and displayed (live WhatsApp pairing)");
    await page.screenshot({ path: "scripts/qa-shots/phase5-qr.png" });
    await page.click("text=Cancel");
    await page.waitForSelector("text=Connect WhatsApp", { timeout: 20000 });
    console.log("✓ disconnect returns to idle state");
  } catch {
    const st = await db.query(`select status, error from whatsapp_sessions where clinic_id = $1`, [clinic.id]);
    console.log(`⚠ QR not shown (status=${st.rows[0].status}, err=${st.rows[0].error}) — WhatsApp servers may be unreachable; connect flow reached '${st.rows[0].status}'`);
    if (!["connecting", "qr"].includes(st.rows[0].status)) throw new Error("connect flow did not start");
  }

  await page.screenshot({ path: "scripts/qa-shots/phase5-inbox.png" });
  await browser.close();

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  if (errors.length) {
    console.error("page errors:", errors.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 5 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
