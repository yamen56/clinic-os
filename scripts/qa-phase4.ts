/** Browser QA for Phase 4: public booking wizard, slot engine, OTP flow, identity rule. */
import { chromium, type Page } from "playwright";
import { Client } from "pg";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

/**
 * Clicks the first day in the date strip that actually offers slots, and returns
 * its index.
 *
 * The clinic's working hours close some weekdays, so a fixed "tomorrow" makes the
 * whole suite fail on those days of the week rather than when something is
 * broken. Skips index 0 (today), which the minimum-notice window can empty out.
 */
async function pickOpenDay(page: Page): Promise<number> {
  const chips = page.locator("button:has(span.tnum)");
  const total = await chips.count();
  for (let i = 1; i < Math.min(total, 10); i++) {
    await chips.nth(i).click();
    try {
      await page.waitForSelector("button.tnum", { timeout: 4000 });
      return i;
    } catch {
      // Closed day or fully booked — try the next one.
    }
  }
  throw new Error("no day in the booking strip offered any slots");
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  // Fixture clinic via SQL (public flow needs no staff login)
  const slug = `qa4-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, address_ar) values ('QA4 Clinic', 'عيادة الاختبار', $1, 'عمان، الدوار السابع') returning id, timezone`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await db.query(`insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 60)`, [clinic.id, slug]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'QA Owner') returning id`,
      [`qa4-owner-${slug}@test.local`]
    )
  ).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'owner')`, [
    clinic.id, owner.id,
  ]);
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'د. أحمد الزعبي') returning id`,
      [`qa4-doc-${slug}@test.local`]
    )
  ).rows[0];
  const member = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, specialty) values ($1, $2, 'doctor', 'طب الأسنان') returning id`,
      [clinic.id, user.id]
    )
  ).rows[0];
  const service = (
    await db.query(
      `insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Checkup', 'كشفية', 30, 15) returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(`insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3)`, [
    service.id, member.id, clinic.id,
  ]);
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ---- Booking 1: WhatsApp offline → skipVerify path
  await page.goto(`${BASE}/book/${slug}`);
  await page.waitForSelector("text=عيادة الاختبار", { timeout: 15000 });
  console.log("✓ public page renders with Arabic clinic branding");
  await page.click("text=كشفية");
  await page.waitForSelector("text=اختر الوقت");
  /*
    Pick the first day in the strip that actually has slots, and remember which.

    This used to take the second chip unconditionally — "tomorrow" — which fails
    every time tomorrow is a Friday, because the seeded clinic uses the default
    working hours and Friday is closed. Booking 2 below reuses the same index on
    purpose: the "taken slot disappeared" assertion only means anything if both
    bookings are on the same day.
  */
  const openDay = await pickOpenDay(page);
  const firstSlotText = await page.locator("button.tnum").first().textContent();
  await page.locator("button.tnum").first().click();
  await page.click("text=متابعة");
  await page.fill('input[placeholder="اسمك الكامل"]', "رنا الشريف");
  await page.fill('input[inputmode="tel"]', "0781234567");
  await page.click("text=إرسال الرمز");
  await page.waitForSelector("text=تم تأكيد الحجز", { timeout: 15000 });
  console.log(`✓ offline booking confirmed instantly (slot ${firstSlotText?.trim()})`);

  const appt1 = await db.query(
    `select a.status, a.source, p.full_name, p.phone_e164, p.source as psource
     from appointments a join patients p on p.id = a.patient_id where a.clinic_id = $1`,
    [clinic.id]
  );
  if (appt1.rowCount !== 1) throw new Error("appointment not created");
  const row = appt1.rows[0];
  if (row.phone_e164 !== "+962781234567" || row.source !== "booking_link" || row.psource !== "booking_link")
    throw new Error(`bad booking row: ${JSON.stringify(row)}`);
  console.log("✓ patient created via identity rule with source booking_link");

  const notif = await db.query(`select count(*)::int as n from notifications where clinic_id = $1`, [clinic.id]);
  if (notif.rows[0].n < 1) throw new Error("staff not notified");
  console.log("✓ staff notified in-app");

  // ---- Booking 2: WhatsApp "connected" → OTP path
  await db.query(`update whatsapp_sessions set status = 'connected' where clinic_id = $1`, [clinic.id]);
  await page.click("text=حجز موعد آخر");
  await page.click("text=كشفية");
  await page.waitForSelector("text=اختر الوقت");
  // The same day as booking 1, so "the taken slot is gone" is a real comparison.
  await page.locator("button:has(span.tnum)").nth(openDay).click();
  await page.waitForSelector("button.tnum", { timeout: 15000 });
  // the first slot should now be a DIFFERENT time (previous one taken)
  const newFirst = await page.locator("button.tnum").first().textContent();
  if (newFirst?.trim() === firstSlotText?.trim())
    throw new Error("slot engine still offers the taken slot");
  console.log("✓ taken slot removed from availability");
  await page.locator("button.tnum").first().click();
  await page.click("text=متابعة");
  await page.fill('input[placeholder="اسمك الكامل"]', "خالد النجار");
  await page.fill('input[inputmode="tel"]', "0791112223");
  await page.click("text=إرسال الرمز");
  await page.waitForSelector("text=أدخل الرمز", { timeout: 15000 });
  console.log("✓ OTP step shown");

  // wrong code first
  const v = await db.query(
    `select id, code from booking_verifications where clinic_id = $1 and verified_at is null order by created_at desc limit 1`,
    [clinic.id]
  );
  const correct = v.rows[0].code as string;
  const wrong = correct === "111111" ? "222222" : "111111";
  await page.fill('input[inputmode="numeric"]', wrong);
  await page.click("text=تأكيد الحجز");
  await page.waitForSelector("text=الرمز غير صحيح", { timeout: 10000 });
  console.log("✓ wrong code rejected");
  await page.fill('input[inputmode="numeric"]', correct);
  await page.click("text=تأكيد الحجز");
  await page.waitForSelector("text=تم تأكيد الحجز", { timeout: 15000 });
  console.log("✓ correct code books the appointment");

  // OTP + confirmation messages queued for the worker
  const msgs = await db.query(
    `select count(*)::int as n from messages where clinic_id = $1 and direction = 'out' and status = 'queued'`,
    [clinic.id]
  );
  if (msgs.rows[0].n < 2) throw new Error(`expected queued outbound messages, got ${msgs.rows[0].n}`);
  console.log(`✓ ${msgs.rows[0].n} outbound WhatsApp messages queued (OTP + confirmations)`);

  // English toggle flips direction
  await page.click("text=EN");
  await page.waitForSelector("text=Book another appointment", { timeout: 8000 });
  console.log("✓ language toggle to English works");

  await page.screenshot({ path: "scripts/qa-shots/phase4-booking.png" });
  await browser.close();

  // cleanup fixture
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = any($1::uuid[])`, [[user.id, owner.id]]);
  await db.end();

  if (errors.length) {
    console.error("page errors:", errors.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 4 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
