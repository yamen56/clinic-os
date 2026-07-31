/**
 * Browser QA for partial payments.
 *
 * The states themselves already worked — the invoice status has computed
 * `partially_paid` since the first migration. What did not work was seeing it:
 * a list row showed the word "Partly paid" next to the full total, which is the
 * one number nobody can act on. So these assertions are mostly about what a
 * person can read off the screen, because that was the actual gap.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
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

/** Confirms the payment modal. Scoped to the dialog: the page behind it has a
 *  "Record payment" button of its own, and the backdrop blocks clicks to it. */
async function modalSave(page: Page) {
  await page.locator(".fixed.inset-0.z-50 button:has-text('Save')").last().click();
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qapay-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, currency, default_locale, invoice_prefix)
       values ('QA Pay', 'دفعات', $1, 'JOD', 'en', 'QAP') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Pay Owner', 'en') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1, 'Nour Haddad', '+962790000222', 'staff') returning id`,
      [clinic.id]
    )
  ).rows[0];

  const mkInvoice = async (seq: number, total: number) =>
    (
      await db.query(
        `insert into invoices (clinic_id, patient_id, number, seq, subtotal, total, status, sent_at)
         values ($1, $2, $3, $4, $5, $5, 'sent', now()) returning id`,
        [clinic.id, patient.id, `QAP-2026-000${seq}`, seq, total]
      )
    ).rows[0].id as string;

  const partlyPaid = await mkInvoice(1, 100);
  const unpaid = await mkInvoice(2, 60);
  const willBePaid = await mkInvoice(3, 40);
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await signIn(page, `owner-${slug}@test.local`);

  /* ------------------------------------- 1. recording less than the full sum */
  await page.goto(`${BASE}/c/${slug}/invoices/${partlyPaid}`);
  await page.waitForLoadState("networkidle");
  await page.click("button:has-text('Record payment')");
  await page.waitForSelector('input[type="number"]', { timeout: 10000 });
  // The amount box defaults to the whole balance; typing less is the whole point.
  await page.fill('input[type="number"]', "30");
  await modalSave(page);
  await page.waitForTimeout(1500);

  const inv = (
    await db.query(`select status, total, amount_paid from invoices where id = $1`, [partlyPaid])
  ).rows[0];
  check("paying part of an invoice marks it partly paid", inv.status === "partially_paid", inv.status);
  check("the amount paid is tracked", Number(inv.amount_paid) === 30, String(inv.amount_paid));

  // Overpaying is refused — the balance is 70, so 100 must not go through.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.click("button:has-text('Record payment')");
  await page.waitForSelector('input[type="number"]', { timeout: 10000 });
  await page.fill('input[type="number"]', "100");
  await modalSave(page);
  await page.waitForTimeout(1200);
  const stillThirty = (
    await db.query(`select amount_paid from invoices where id = $1`, [partlyPaid])
  ).rows[0];
  check(
    "paying more than is owed is refused",
    Number(stillThirty.amount_paid) === 30,
    String(stillThirty.amount_paid)
  );

  /* ------------------------------------------- 2. the list says how much is left */
  await page.goto(`${BASE}/c/${slug}/invoices`);
  await page.waitForLoadState("networkidle");
  const row = page.locator("li", { hasText: "QAP-2026-0001" }).first();
  const rowText = (await row.textContent()) ?? "";
  check("the list shows what has been paid", /30/.test(rowText), rowText.replace(/\s+/g, " ").trim());
  check("and what is still owed", /70/.test(rowText), rowText.replace(/\s+/g, " ").trim());
  check("alongside the full total", /100/.test(rowText));

  /* ------------------------------------------------- 3. partly paid is its own filter */
  check(
    "there is a Partly paid filter",
    (await page.getByRole("link", { name: /Partly paid/i }).count()) > 0
  );
  // The chips are client-side links, so networkidle can settle while the old
  // list is still on screen. Wait for the URL the filter actually produces.
  await page.getByRole("link", { name: /Partly paid/i }).first().click();
  await page.waitForURL(/status=partial/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  check(
    "it shows the partly paid invoice",
    (await page.locator("text=QAP-2026-0001").count()) > 0
  );
  check(
    "and hides the one nobody has paid",
    (await page.locator("text=QAP-2026-0002").count()) === 0
  );

  await page.getByRole("link", { name: /^Paid$/ }).first().click();
  await page.waitForURL(/status=paid/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  check(
    "the Paid filter excludes a partly paid invoice",
    (await page.locator("text=QAP-2026-0001").count()) === 0
  );

  /* ---------------------------------------- 4. settling it moves it to paid */
  await page.goto(`${BASE}/c/${slug}/invoices/${willBePaid}`);
  await page.waitForLoadState("networkidle");
  await page.click("button:has-text('Record payment')");
  await page.waitForSelector('input[type="number"]', { timeout: 10000 });
  await modalSave(page); // defaults to the full balance
  await page.waitForTimeout(1500);
  const settled = (
    await db.query(`select status from invoices where id = $1`, [willBePaid])
  ).rows[0];
  check("paying the balance in full marks it paid", settled.status === "paid", settled.status);

  /* --------------------------- 5. the ledger tells a deposit from a settlement */
  await page.goto(`${BASE}/c/${slug}/invoices?tab=payments`);
  await page.waitForLoadState("networkidle");
  const ledger = (await page.locator("ul li").allTextContents()).join(" | ");
  check("the payments list marks the one that left a balance", /still due/i.test(ledger), ledger.slice(0, 160));
  check("and the one that closed its invoice", /Settled/i.test(ledger));

  /* ------------------------------------ 6. the patient's own file agrees */
  await page.goto(`${BASE}/c/${slug}/patients/${patient.id}`);
  await page.waitForLoadState("networkidle");
  await page.click("button[role='tab']:has-text('Invoices')");
  await page.waitForTimeout(400);
  const patientTab = (await page.locator("ul li").allTextContents()).join(" | ");
  check(
    "the patient file shows the outstanding balance too",
    /70/.test(patientTab),
    patientTab.slice(0, 160)
  );

  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  console.log(`\n  payments: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  void unpaid;
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
