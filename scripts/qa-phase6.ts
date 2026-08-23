/** Browser QA for Phase 6: invoice creation, numbering, PDF, WhatsApp send, payments, CSV. */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qa6-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, invoice_prefix, payment_instructions, address_ar)
       values ('QA6 Clinic', 'عيادة ريما', $1, 'RIMA', 'CliQ: RIMA123', 'عمان') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA6 Owner', 'en') returning id`,
      [`owner-qa6-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'other', true, '{"level":"full"}')`, [clinic.id, owner.id]);
  await db.query(
    `insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'هالة عبدالله', '+962795551234', 'staff')`,
    [clinic.id]
  );
  await db.query(
    `insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Filling', 'حشوة', 45, 35)`,
    [clinic.id]
  );
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-qa6-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });

  // 1. Create invoice: service line + custom line + discount
  await page.goto(`${BASE}/c/${slug}/invoices/new`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[placeholder="Search by name or phone…"]', "هالة");
  await page.waitForSelector("text=هالة عبدالله", { timeout: 10000 });
  await page.click("button:has-text('هالة عبدالله')");
  await page.click("button:has-text('+ Filling')");
  await page.click("text=Custom item");
  await page.locator('input[placeholder="Item"]').last().fill("أشعة بانوراما");
  /*
    By label, not by position. Tax and discount moved onto the line, so a row is
    now four number boxes rather than two and "the third input with step 0.5" is
    whatever the layout last happened to make it.
  */
  await page.getByLabel("Price", { exact: true }).nth(1).fill("20"); // custom item price
  await page.getByLabel("Discount", { exact: true }).nth(1).fill("5"); // on that line
  await page.waitForTimeout(300);
  await page.click("button:has-text('Create')");
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 30000 });
  console.log("✓ invoice created");

  const inv = (
    await db.query(
      `select id, number, seq, subtotal, discount_amount, total, public_token, status
       from invoices where clinic_id = $1`,
      [clinic.id]
    )
  ).rows[0];
  if (!/^RIMA-\d{4}-0001$/.test(inv.number)) throw new Error(`bad number: ${inv.number}`);
  if (Number(inv.subtotal) !== 55 || Number(inv.total) !== 50)
    throw new Error(`bad totals: ${inv.subtotal} / ${inv.total}`);
  console.log(`✓ numbering ${inv.number}, totals 55 − 5 = 50`);

  // 2. Public branded page
  const detailUrl = page.url();
  await page.goto(`${BASE}/inv/${inv.public_token}`);
  await page.waitForSelector("text=عيادة ريما", { timeout: 15000 });
  const pubText = await page.textContent("body");
  if (!pubText?.includes("Filling") || !pubText.includes("بانوراما") || !pubText.includes("CliQ: RIMA123"))
    throw new Error("public invoice missing content");
  await page.screenshot({ path: "scripts/qa-shots/phase6-invoice-public.png", fullPage: true });
  console.log("✓ public branded invoice page (Arabic RTL)");
  await page.goto(detailUrl);
  await page.waitForLoadState("networkidle");

  // 3. PDF renders
  const pdfRes = await page.request.get(`${BASE}/api/c/${slug}/invoices/${inv.id}/pdf`);
  if (pdfRes.status() !== 200 || !(await pdfRes.body()).subarray(0, 4).equals(Buffer.from("%PDF")))
    throw new Error(`pdf failed: ${pdfRes.status()}`);
  console.log(`✓ PDF generated (${((await pdfRes.body()).length / 1024).toFixed(0)} KB)`);

  // 4. Send over WhatsApp → queued document message + status sent
  await page.click("button:has-text('Send on WhatsApp')");
  await page.waitForSelector("text=Invoice sent on WhatsApp", { timeout: 45000 });
  const sentMsg = await db.query(
    `select m.msg_type, m.status, m.media_mime from messages m
     where m.clinic_id = $1 and m.direction = 'out' order by m.created_at desc limit 1`,
    [clinic.id]
  );
  if (sentMsg.rows[0].msg_type !== "document" || sentMsg.rows[0].media_mime !== "application/pdf")
    throw new Error(`bad wa message: ${JSON.stringify(sentMsg.rows[0])}`);
  const invAfter = (await db.query(`select status, sent_at from invoices where id = $1`, [inv.id])).rows[0];
  if (invAfter.status !== "sent" || !invAfter.sent_at) throw new Error("invoice not marked sent");
  console.log("✓ invoice queued to WhatsApp as PDF document; status → sent");

  // 5. Partial payment then final payment
  await page.click("button:has-text('Record payment')");
  await page.waitForSelector('div[role="dialog"]');
  await page.locator('div[role="dialog"] input[type="number"]').fill("20");
  await page.locator('div[role="dialog"] button:has-text("Save")').click();
  await page.waitForSelector("text=Payment recorded", { timeout: 10000 });
  let st = (await db.query(`select status, amount_paid from invoices where id = $1`, [inv.id])).rows[0];
  if (st.status !== "partially_paid" || Number(st.amount_paid) !== 20)
    throw new Error(`bad partial state: ${JSON.stringify(st)}`);
  console.log("✓ partial payment → partially_paid");

  await page.click("button:has-text('Record payment')");
  await page.waitForSelector('div[role="dialog"]');
  await page.locator('div[role="dialog"] input[type="number"]').fill("30");
  await page.locator('div[role="dialog"] button:has-text("Save")').click();
  for (let i = 0; i < 20; i++) {
    st = (await db.query(`select status, amount_paid from invoices where id = $1`, [inv.id])).rows[0];
    if (st.status === "paid") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (st.status !== "paid") throw new Error(`not paid: ${JSON.stringify(st)}`);
  console.log("✓ full payment → paid");

  // 6. Overpay rejected
  const over = await db.query(
    `insert into invoices (clinic_id, patient_id, seq, number, subtotal, total)
     select $1, p.id, 99, 'RIMA-TEST-0099', 10, 10 from patients p where p.clinic_id = $1 limit 1 returning id`,
    [clinic.id]
  );
  await page.goto(`${BASE}/c/${slug}/invoices/${over.rows[0].id}`);
  await page.click("button:has-text('Record payment')");
  await page.waitForSelector('div[role="dialog"]');
  await page.locator('div[role="dialog"] input[type="number"]').fill("50");
  await page.locator('div[role="dialog"] button:has-text("Save")').click();
  await page.waitForSelector("text=Amount is more than", { timeout: 10000 });
  console.log("✓ overpayment rejected");

  // 7. Payments overview + CSV
  await page.goto(`${BASE}/c/${slug}/invoices?tab=payments`);
  await page.waitForSelector("text=Cash", { timeout: 10000 });
  const csvRes = await page.request.get(`${BASE}/api/c/${slug}/payments/export`);
  const csv = await csvRes.text();
  if (!csv.includes("RIMA-") || !csv.includes("20.00")) throw new Error("csv missing rows");
  console.log("✓ payments overview + CSV export");

  await page.screenshot({ path: "scripts/qa-shots/phase6-invoices.png" });
  await browser.close();

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  if (errors.length) {
    console.error("page errors:", errors.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 6 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
