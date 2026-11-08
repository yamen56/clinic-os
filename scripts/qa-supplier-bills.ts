/**
 * What the clinic owes its suppliers (ذمم, 0099).
 *
 * Yamen, 2026-11-08: "I have 2000 in stock but I still didn't pay this price, I
 * want the system to be able to calculate it." So: a delivery taken on credit is
 * on hand and owed, not spent; a bill can be added by hand; paying — whole or in
 * parts, oldest bill first — writes the expense on the day the money leaves; and
 * the figure owed is everything, the outside labs included.
 *
 * The things that must not happen are checked as hard as the things that must:
 * a debt counted as spending before it is paid, a payment that overshoots, an
 * edit that makes the supplier owe the clinic, a deleted bill taking paid money
 * out of Expenses with it.
 *
 *   npx tsx scripts/qa-supplier-bills.ts       (against a warm dev server)
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";

let passed = 0;
let failed = 0;
const check = (cond: unknown, m: string, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${m}`);
  } else {
    failed++;
    console.log(`  ✗ ${m}${detail ? ` — ${detail}` : ""}`);
  }
};
async function until(fn: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function signIn(browser: Browser, email: string, width = 1440): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

/** Waits until React has attached to an element, so a click on it is heard. */
const hydrated = (page: Page, sel: string) =>
  page.waitForFunction(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && Object.keys(e).some((k) => k.startsWith("__reactProps")); })()`,
    undefined,
    { timeout: 120000 }
  );

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const slug = `qabills${tag}`;
  const today = DateTime.now().setZone(TZ).toISODate()!;
  const daysAgo = (n: number) => DateTime.now().setZone(TZ).minus({ days: n }).toISODate()!;

  // Both charts: stock is the face chart's, lab work the dental one's.
  const [clinic] = await q(
    `insert into clinics (name, slug, specialty, currency, timezone, features)
     values ('QA Bills', $1, 'dermatology', 'JOD', $2, '{"aesthetic": true, "dental": true}') returning id`,
    [slug, TZ]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  const email = `bills-owner-${tag}@test.local`;
  const [user] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`, [
    email,
    bcrypt.hashSync("password123", 10),
  ]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [
    clinic.id,
    user.id,
  ]);
  const [allergan] = await q(`insert into aesthetic_companies (clinic_id, name) values ($1, 'Allergan') returning id`, [clinic.id]);
  const [botox] = await q(
    `insert into aesthetic_products (clinic_id, company_id, name, unit, pack_size, treatments) values ($1, $2, 'Botox', 'u', 100, '{toxin}') returning id`,
    [clinic.id, allergan.id]
  );
  // An outside lab owed 120 for a crown, paid from the Lab work page.
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Lina Bills', '+962790005151', 'staff') returning id`, [
    clinic.id,
  ]);
  const [lab] = await q(`insert into dental_labs (clinic_id, name) values ($1, 'Smile Lab') returning id`, [clinic.id]);
  const [mark] = await q(
    `insert into chart_marks (clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status)
     values ($1, $2, '11', 'crown', 'Crown', 'تاج', 'crown', 'procedure', 'done') returning id`,
    [clinic.id, patient.id]
  );
  await q(`insert into lab_cases (clinic_id, patient_id, mark_id, lab_id, cost, sent_on) values ($1, $2, $3, $4, 120, current_date)`, [
    clinic.id,
    patient.id,
    mark.id,
    lab.id,
  ]);

  const bills = () => q(`select *, amount::float as amount, to_char(due_on, 'YYYY-MM-DD') as due from supplier_bills where clinic_id = $1 order by incurred_on, created_at`, [clinic.id]);
  const expenses = () =>
    q(`select *, amount::float as amount, to_char(spent_on, 'YYYY-MM-DD') as day from expenses where clinic_id = $1 order by created_at`, [clinic.id]);
  const owedOn = async (page: Page) => Number(await page.locator("[data-to-pay]").getAttribute("data-to-pay"));

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const page = await signIn(browser, email);
    page.on("pageerror", (e) => errors.push(e.message));

    /* ── A delivery taken on credit ─────────────────────────────────── */
    console.log("A delivery taken on credit");
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 180000 });
    await page.waitForSelector("[data-stock-receive]", { timeout: 120000 });
    await hydrated(page, "[data-stock-receive]");
    await page.locator("[data-stock-receive]").click();
    await page.locator("[data-receive-product]").selectOption(botox.id);
    await page.locator("[data-receive-packs]").fill("2");
    await page.locator("[data-receive-price]").fill("1000");
    await page.locator("[data-receive-payment]").selectOption("owed");
    check((await page.getByRole("dialog").innerText()).includes("owed to Allergan until it is paid"), "the summary says it is owed to Allergan, not spent");
    await page.locator("[data-receive-due]").fill(DateTime.now().setZone(TZ).plus({ days: 30 }).toISODate()!);
    await page.locator("[data-receive-save]").click();
    check(await until(async () => (await bills()).length === 1), "receiving it on credit writes a bill");
    const [credit] = await bills();
    check(credit?.amount === 2000 && credit?.company_id === allergan.id && !!credit?.due, "for 2,000, owed to Allergan, with the day to pay by", JSON.stringify(credit));
    const [batch] = await q(`select * from stock_batches where clinic_id = $1`, [clinic.id]);
    check(batch?.bill_id === credit?.id && batch?.expense_id === null, "the delivery points at its bill and has no expense");
    check((await expenses()).length === 0, "and nothing is spent yet");
    check(await until(async () => (await page.locator("[data-stock-on-hand]").first().getAttribute("data-stock-on-hand")) === "200"), "the 200 units are on hand all the same");
    check(await until(async () => (await page.locator("[data-stock-to-pay]").getAttribute("data-stock-to-pay")) === "2000"), "Stock says 2,000 is still to pay the companies");
    await page.getByRole("button", { name: /Batches/ }).first().click();
    check((await page.locator("[data-batch-unpaid]").first().innerText()).includes("2,000.00"), "and the delivery says it is not paid");

    /* ── To pay on Expenses ─────────────────────────────────────────── */
    console.log("To pay on Expenses");
    await page.goto(`${BASE}/c/${slug}/expenses`, { timeout: 180000 });
    await page.waitForSelector("[data-to-pay]", { timeout: 120000 });
    await hydrated(page, "[data-bill-add]");
    check((await owedOn(page)) === 2120, "everything owed: 2,000 to Allergan and 120 to the lab", String(await owedOn(page)));
    check((await page.locator("[data-labs-owed]").getAttribute("data-labs-owed")) === "120", "the lab's 120 is listed beside the suppliers");

    // A bill typed by hand, already past its day.
    await page.locator("[data-bill-add]").click();
    check((await page.locator("[data-expense-form]").getAttribute("data-expense-form")) === "bill", "Add a bill opens the form as a bill");
    await page.locator("[data-expense-amount]").fill("300");
    await page.getByRole("dialog").locator('input[type="date"]').first().fill(daysAgo(10));
    await page.locator("[data-bill-due-input]").fill(daysAgo(2));
    await page.locator("[data-expense-vendor]").fill("Dental Depot");
    await page.locator("[data-expense-save]").click();
    check(await until(async () => (await bills()).length === 2), "it is saved as a bill");
    check((await expenses()).length === 0, "still nothing spent");
    await page.waitForSelector('[data-supplier="Dental Depot"]', { timeout: 30000 });
    check((await page.locator('[data-supplier="Dental Depot"] [data-bill-due="late"]').count()) === 1, "a bill past its day says it is overdue");

    // Owed to the same supplier, typed differently: one supplier, two bills.
    await q(`insert into supplier_bills (clinic_id, vendor, amount, incurred_on) values ($1, ' dental  depot', 200, $2)`, [clinic.id, daysAgo(20)]);
    await page.reload();
    await page.waitForSelector('[data-supplier="Dental Depot"], [data-supplier=" dental  depot"]', { timeout: 60000 });
    const depot = page.locator("[data-supplier]").filter({ has: page.locator("[data-bill]") }).filter({ hasText: /depot/i });
    check((await depot.count()) === 1 && (await depot.locator("[data-bill]").count()) === 2, "the same supplier typed two ways is one supplier");
    check((await depot.locator("[data-supplier-owed]").getAttribute("data-supplier-owed")) === "500", "owed 500 in all");

    /* ── Paying ─────────────────────────────────────────────────────── */
    console.log("Paying");
    await hydrated(page, "[data-supplier-pay]");
    const allerganRow = page.locator('[data-supplier="Allergan"]');
    await allerganRow.locator("[data-supplier-pay]").click();
    check((await page.locator("[data-pay-amount]").inputValue()) === "2000.00", "Pay offers what Allergan is owed");
    await page.locator("[data-pay-amount]").fill("2500");
    check(await page.locator("[data-pay-save]").isDisabled(), "and will not pay more than that");
    await page.locator("[data-pay-amount]").fill("500");
    await page.locator("[data-pay-method]").selectOption("transfer");
    await page.locator("[data-pay-save]").click();
    check(await until(async () => (await expenses()).length === 1), "paying 500 writes an expense");
    const [paid] = await expenses();
    const supplies = (await q(`select id from expense_categories where clinic_id = $1 and key = 'supplies'`, [clinic.id]))[0].id;
    check(
      paid?.amount === 500 && paid?.bill_id === credit.id && paid?.method === "transfer" && paid?.category_id === supplies && paid?.vendor === "Allergan",
      "of 500, toward the delivery's bill, by transfer, under Supplies, to Allergan",
      JSON.stringify(paid)
    );
    check(paid?.day === today, "on the day it was paid, not the day the goods came", String(paid?.day));
    check(await until(async () => (await allerganRow.locator("[data-supplier-owed]").getAttribute("data-supplier-owed")) === "1500"), "Allergan is owed 1,500 now");
    check((await page.locator("[data-expense-stock]").first().innerText()).includes("Botox"), "and the payment in Expenses says which delivery it paid for");

    // Undo takes back exactly that payment.
    await page.locator("[data-toast-action]").last().click();
    check(await until(async () => (await expenses()).length === 0), "Undo takes the payment back");
    check(await until(async () => (await allerganRow.locator("[data-supplier-owed]").getAttribute("data-supplier-owed")) === "2000"), "and Allergan is owed 2,000 again");

    // Two bills, one payment: the oldest is settled first.
    await depot.locator("[data-supplier-pay]").click();
    await page.locator("[data-pay-amount]").fill("400");
    await page.locator("[data-pay-save]").click();
    check(await until(async () => (await expenses()).length === 2), "400 to Dental Depot is split over its two bills");
    const split = await q(
      `select b.amount::float as bill, e.amount::float as paid from expenses e join supplier_bills b on b.id = e.bill_id where e.clinic_id = $1 order by b.incurred_on`,
      [clinic.id]
    );
    check(split[0]?.bill === 200 && split[0]?.paid === 200 && split[1]?.bill === 300 && split[1]?.paid === 200, "the older 200 in full, then 200 of the 300", JSON.stringify(split));
    check(
      await until(async () => (await depot.locator("[data-supplier-owed]").getAttribute("data-supplier-owed")) === "100"),
      "leaving 100 owed",
      `${await depot.count()} rows: ${(await page.locator("[data-supplier]").allInnerTexts()).join(" | ").replace(/\s+/g, " ")}`
    );
    check((await depot.getAttribute("data-supplier")) === "Dental Depot", "under the name as last typed, tidied", String(await depot.getAttribute("data-supplier")));

    // An edit may not make the supplier owe the clinic.
    const newer = (await bills()).find((b) => b.amount === 300)!;
    await page.locator(`[data-bill="${newer.id}"] [data-bill-edit]`).click();
    await page.locator("[data-expense-amount]").fill("150");
    await page.locator("[data-expense-save]").click();
    check(await until(async () => (await page.locator("text=More than that has already been paid toward this bill.").count()) > 0), "a bill cannot be cut below what was paid toward it");
    check((await bills()).find((b) => b.id === newer.id)?.amount === 300, "and stays at 300");
    await page.keyboard.press("Escape");

    // Deleting a bill leaves the money already paid in Expenses.
    await page.locator(`[data-bill="${newer.id}"] [data-bill-delete]`).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    check(await until(async () => !(await bills()).some((b) => b.id === newer.id)), "a bill can be deleted");
    check(
      (await expenses()).length === 2 && (await expenses()).some((e) => e.bill_id === null && e.amount === 200),
      "and what was paid toward it stays in Expenses"
    );

    // Paying Allergan in full takes them off the list.
    await page.reload();
    await page.waitForSelector('[data-supplier="Allergan"]', { timeout: 60000 });
    await hydrated(page, "[data-supplier-pay]");
    await page.locator('[data-supplier="Allergan"] [data-supplier-pay]').click();
    await page.locator("[data-pay-save]").click();
    check(await until(async () => (await page.locator('[data-supplier="Allergan"]').count()) === 0), "paid in full, Allergan is off the list");
    check(await until(async () => (await owedOn(page)) === 120), "and what is owed is the lab's 120", String(await owedOn(page)));
    const spent = (await q(`select coalesce(sum(amount), 0)::float as n from expenses where clinic_id = $1`, [clinic.id]))[0].n;
    check(spent === 2400, "Expenses holds exactly what left: 2,000 + 200 + 200", String(spent));

    /* ── Lab work ───────────────────────────────────────────────────── */
    console.log("Lab work");
    await page.locator("[data-labs-owed] a").click();
    await page.waitForURL((u) => u.pathname.endsWith("/labs"), { timeout: 60000 });
    check(await until(async () => (await page.locator("[data-lab-pay]").count()) === 1, 60000), "the lab's line opens Lab work on To pay");

    /* ── Stock again ────────────────────────────────────────────────── */
    console.log("Stock again");
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 180000 });
    await page.waitForSelector("[data-stock-receive]", { timeout: 120000 });
    check((await page.locator("[data-stock-to-pay]").count()) === 0, "nothing still to pay: Stock stops saying so");

    // A delivery entered on credit by mistake: deleting it takes its bill with it, and Undo brings both back.
    await hydrated(page, "[data-stock-receive]");
    await page.locator("[data-stock-receive]").click();
    await page.locator("[data-receive-product]").selectOption(botox.id);
    await page.locator("[data-receive-packs]").fill("1");
    await page.locator("[data-receive-price]").fill("900");
    await page.locator("[data-receive-payment]").selectOption("owed");
    await page.locator("[data-receive-save]").click();
    check(await until(async () => (await bills()).some((b) => b.amount === 900)), "another delivery on credit");
    const mistake = (await bills()).find((b) => b.amount === 900)!;
    const [mBatch] = await q(`select id from stock_batches where bill_id = $1`, [mistake.id]);
    if (!(await page.locator(`[data-stock-batch="${mBatch.id}"]`).isVisible())) await page.getByRole("button", { name: /Batches/ }).first().click();
    await page.locator(`[data-stock-batch="${mBatch.id}"] [data-batch-delete]`).click();
    check(await until(async () => !(await bills()).some((b) => b.id === mistake.id)), "deleting the delivery takes its unpaid bill with it");
    await page.locator("[data-toast-action]").last().click();
    check(
      await until(async () => (await q(`select bill_id from stock_batches where id = $1`, [mBatch.id]))[0]?.bill_id === mistake.id),
      "Undo brings the delivery back, still owed"
    );

    /* ── On a phone ─────────────────────────────────────────────────── */
    console.log("On a phone");
    const phone = await signIn(browser, email, 390);
    await phone.goto(`${BASE}/c/${slug}/expenses`, { timeout: 180000 });
    await phone.waitForSelector("[data-supplier-pay]", { timeout: 120000 });
    const box = await phone.locator("[data-supplier-pay]").first().boundingBox();
    check(!!box && box.x >= 0 && box.x + box.width <= 390, "Pay is on the screen", JSON.stringify(box));
    const wide = Number(await phone.evaluate("document.documentElement.scrollWidth"));
    check(wide <= 390, "and the page does not scroll sideways", String(wide));
    await phone.context().close();

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]);
    await q(`delete from users where email like $1`, [`%-${tag}@test.local`]);
    await db.end();
  }

  console.log(`\nsupplier bills: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
