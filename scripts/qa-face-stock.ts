/**
 * The face chart's products, stock and packages (0085).
 *
 * Yamen, 2026-10-28: a 100 treatment that used 50 of product, the companies
 * the doctor adds, stock from the first version, packages — "complete the
 * rest", no body, colours without dots, every note in the patient's notes.
 *
 * - Stock: companies and products from the Stock page; a delivery is a batch
 *   and a Supplies expense; a treatment takes from the batch that expires
 *   first, at that batch's cost; voided, it gives the units back; used with
 *   none on hand, the next delivery settles it.
 * - Prices by product: a Botox price above the toxin's.
 * - The doctor's share: (price − product) × rate on the shared deal.
 * - Packages: set up in Settings, sold from the chart and billed like any
 *   work; a session from it costs nothing more and earns its doctor its part
 *   of the price; a package in use cannot be voided; a bundle's price split
 *   by the list.
 * - Notes: a note edited on a treatment, and a package's, are in Notes.
 *
 * Run against a warm server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { earningsForDoctor } from "../src/lib/earnings";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

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

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const c = db as unknown as PoolClient;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qastock${tag}`;
  const [clinic] = await q(`insert into clinics (name, slug, specialty, features) values ('QA Stock', $1, 'dermatology', '{"aesthetic": true}') returning id`, [slug]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  const email = `stock-doc-${tag}@test.local`;
  const [user] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Dr Stock', 'en') returning id`, [email, hash]);
  const [doc] = await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions, commission_percent, costs_rule)
     values ($1, $2, 'doctor', true, 'Dr.', '{"level":"full"}', 40, 'shared') returning id`,
    [clinic.id, user.id]
  );
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Rana Stock', '+962790004242', 'staff') returning id`, [clinic.id]);
  // A dental clinic, for the gate.
  const dslug = `qastockdent${tag}`;
  const [dclinic] = await q(`insert into clinics (name, slug, specialty, features) values ('QA Stock Dent', $1, 'dental', '{"dental": true}') returning id`, [dslug]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [dclinic.id]);
  const demail = `stock-dent-${tag}@test.local`;
  const [duser] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Dr Dent', 'en') returning id`, [demail, hash]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1, $2, 'doctor', true, 'Dr.', '{"level":"full"}')`, [dclinic.id, duser.id]);

  const api = (page: Page, path: string) => `${BASE}/api/c/${slug}/patients/${patient.id}/face${path}`;
  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    /* ── The gate ───────────────────────────────────────────────────── */
    console.log("The gate");
    const dp = await signIn(browser, demail);
    await dp.goto(`${BASE}/c/${dslug}/stock`, { timeout: 180000 });
    check(await until(async () => !dp.url().includes("/stock"), 30000), "a dental clinic has no Stock page");
    check((await dp.locator("nav a", { hasText: "Stock" }).count()) === 0, "nor a Stock entry in its nav");
    await dp.context().close();

    const page = await signIn(browser, email);
    page.on("pageerror", (e) => errors.push(e.message));

    /* ── Companies and products ─────────────────────────────────────── */
    console.log("Companies and products");
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 180000 });
    await page.waitForSelector("[data-stock]", { timeout: 120000 });
    check((await page.locator("nav a", { hasText: "Stock" }).count()) > 0, "an aesthetic clinic has Stock in its nav");
    await page.getByRole("button", { name: "Companies" }).click();
    await page.locator("[data-company-name]").fill("Allergan");
    await page.locator("[data-company-add]").click();
    check(await until(async () => (await q(`select 1 from aesthetic_companies where clinic_id = $1 and name = 'Allergan'`, [clinic.id])).length === 1), "a company is added: Allergan");
    await page.keyboard.press("Escape");
    const allergan = (await q(`select id from aesthetic_companies where clinic_id = $1 and name = 'Allergan'`, [clinic.id]))[0].id;

    await page.locator("[data-stock-new-product]").click();
    await page.locator("[data-product-name]").fill("Botox 100u");
    await page.locator("[data-product-company]").selectOption(allergan);
    await page.locator("[data-product-unit]").selectOption("u");
    await page.locator("[data-product-pack]").fill("100");
    await page.locator("[data-product-treatment='aes_toxin']").check();
    await page.locator("[data-product-save]").click();
    const productOf = async (name: string) => (await q(`select *, pack_size::float as pack_size from aesthetic_products where clinic_id = $1 and name = $2`, [clinic.id, name]))[0];
    check(await until(async () => !!(await productOf("Botox 100u"))), "a product is added: Botox 100u, by Allergan");
    const botox = await productOf("Botox 100u");
    check(botox.unit === "u" && botox.pack_size === 100 && botox.treatments.includes("aes_toxin") && botox.company_id === allergan, "counted in units, 100 a vial, used in the toxin");

    /* ── Deliveries ─────────────────────────────────────────────────── */
    console.log("Deliveries");
    const receive = async (packs: string, price: string, lot: string, expires: string) => {
      await page.locator("[data-stock-receive]").click();
      await page.locator("[data-receive-product]").selectOption(botox.id);
      await page.locator("[data-receive-packs]").fill(packs);
      await page.locator("[data-receive-price]").fill(price);
      await page.locator("[data-receive-lot]").fill(lot);
      await page.locator("[data-receive-expires]").fill(expires);
      await page.locator("[data-receive-save]").click();
      await until(async () => (await q(`select 1 from stock_batches where product_id = $1 and lot = $2`, [botox.id, lot])).length === 1);
      await page.waitForTimeout(300);
    };
    await receive("1", "110", "LATE-27", "2027-06-30");
    await receive("1", "120", "SOON-27", "2027-01-31");
    const batches = await q(`select lot, qty::float as qty, unit_cost::float as unit_cost, expense_id from stock_batches where product_id = $1 order by lot`, [botox.id]);
    check(batches.length === 2 && batches.every((b) => b.qty === 100), "two vials come in, 100 units each");
    check(batches.find((b) => b.lot === "LATE-27")?.unit_cost === 1.1 && batches.find((b) => b.lot === "SOON-27")?.unit_cost === 1.2, "at 1.10 and 1.20 a unit");
    const expenses = await q(
      `select e.amount::float as amount, ec.key from expenses e join expense_categories ec on ec.id = e.category_id where e.clinic_id = $1 order by e.amount`,
      [clinic.id]
    );
    check(expenses.length === 2 && expenses[0].amount === 110 && expenses[1].amount === 120 && expenses.every((e) => e.key === "supplies"), "each delivery is an expense under Supplies", JSON.stringify(expenses));
    check(await until(async () => (await page.locator(`[data-stock-product='${botox.id}'] [data-stock-on-hand]`).getAttribute("data-stock-on-hand")) === "200"), "the Stock page shows 200 units on hand");

    /* ── Prices, by product ─────────────────────────────────────────── */
    console.log("Prices by product");
    await page.goto(`${BASE}/c/${slug}/settings/face-prices`, { timeout: 120000 });
    await page.waitForSelector("[data-face-prices]", { timeout: 60000 });
    await page.locator("[data-price-box='aes_toxin']").fill("70");
    await page.locator("[data-price-box='aes_toxin']").press("Enter");
    check(await until(async () => (await q(`select 1 from services where clinic_id = $1 and chart_key = 'aes_toxin' and chart_variant is null and price = 70`, [clinic.id])).length === 1), "the toxin at 70 an area");
    await page.locator(`[data-price-box='aes_toxin:${botox.id}']`).fill("80");
    await page.locator(`[data-price-box='aes_toxin:${botox.id}']`).press("Enter");
    check(
      await until(async () => (await q(`select 1 from services where clinic_id = $1 and chart_key = 'aes_toxin' and chart_variant = $2 and price = 80`, [clinic.id, botox.id])).length === 1),
      "and with Botox, its own price: 80 an area"
    );
    await page.locator("[data-price-box='aes_laser_hair']").fill("30");
    await page.locator("[data-price-box='aes_laser_hair']").press("Enter");
    await page.locator("[data-price-box='aes_filler']").fill("150");
    await page.locator("[data-price-box='aes_filler']").press("Enter");
    await until(async () => (await q(`select 1 from services where clinic_id = $1 and chart_key in ('aes_laser_hair', 'aes_filler')`, [clinic.id])).length === 2);

    /* ── A toxin with Botox ─────────────────────────────────────────── */
    console.log("A toxin with Botox");
    const fileUrl = `${BASE}/c/${slug}/patients/${patient.id}?tab=face`;
    await page.goto(fileUrl, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    await page.locator("[data-face-preset='upper']").click();
    await page.locator("[data-face-treatment='aes_toxin']").click();
    await page.waitForSelector("[data-face-panel='record']");
    check((await page.locator(`[data-face-product='${botox.id}']`).getAttribute("aria-pressed")) === "true", "Botox, which is on hand, is picked for the toxin");
    check((await page.locator("[data-face-qty]").inputValue()) === "54", "the amount used is the units given: 54");
    check((await page.locator("[data-face-fee]").getAttribute("data-face-fee")) === "240", "priced with Botox: 3 areas × 80 = 240");
    check((await page.locator("[data-face-cost]").getAttribute("data-face-cost")) === "64.8", "its product costs 54 × 1.20 from the batch that expires first: 64.80");
    await page.locator("[data-face-doer]").selectOption(doc.id);
    await page.locator("[data-face-note-input]").fill("Botox batch SOON-27");
    await page.locator("[data-face-save]").click();
    const marksOf = async (key: string) =>
      q(`select *, fee::float as fee from chart_marks where clinic_id = $1 and treatment_key = $2 and voided_at is null order by created_at`, [clinic.id, key]);
    check(await until(async () => (await q(`select 1 from chart_mark_products where clinic_id = $1`, [clinic.id])).length === 1), "saved, with the product it used");
    const [toxin] = await marksOf("aes_toxin");
    const [used] = await q(`select qty::float as qty, cost::float as cost from chart_mark_products where mark_id = $1`, [toxin.id]);
    check(toxin.fee === 240 && used.qty === 54 && used.cost === 64.8, "240 to the patient, 64.80 of product, frozen on it", JSON.stringify({ fee: toxin.fee, used }));
    const onHand = async (lot: string) =>
      Number((await q(`select coalesce(sum(m.qty), 0)::float as n from stock_moves m join stock_batches b on b.id = m.batch_id where b.lot = $1 and b.product_id = $2`, [lot, botox.id]))[0].n);
    check((await onHand("SOON-27")) === 46 && (await onHand("LATE-27")) === 100, "taken from the batch that expires first: 46 left of it, the other untouched");

    /* ── The doctor's share ─────────────────────────────────────────── */
    console.log("The doctor's share");
    const lineValues = (p: Page) => p.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    await page.goto(`${BASE}/c/${slug}/invoices/new?patient=${patient.id}&marks=${toxin.id}`, { timeout: 120000 });
    await until(async () => (await lineValues(page)).some((v) => v.startsWith("Botulinum toxin")), 60000);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60000 });
    const inv1 = new URL(page.url()).pathname.split("/").pop()!;
    await q(`insert into payments (clinic_id, invoice_id, patient_id, amount, method) values ($1, $2, $3, 240, 'cash')`, [clinic.id, inv1, patient.id]);
    await q(`update invoices set amount_paid = 240, status = 'paid' where id = $1`, [inv1]);
    const scope = { clinicId: clinic.id as string, from: new Date("2020-01-01"), to: new Date("2099-01-01") };
    const share1 = await earningsForDoctor(c, scope, doc.id);
    check(Math.abs(share1.earned - 70.08) < 0.005, "paid in full, the doctor earns (240 − 64.80) × 40% = 70.08", JSON.stringify(share1));
    check(Math.abs(share1.costs - 64.8) < 0.005, "and the product shows as the work's cost", String(share1.costs));

    /* ── Voided, used without stock ─────────────────────────────────── */
    console.log("Voided, and used without stock");
    const second = crypto.randomUUID();
    await page.request.post(api(page, "/marks"), {
      data: { id: second, eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "glabella", units: 20 }], product: { id: botox.id, qty: 20 } },
    });
    check((await onHand("SOON-27")) === 26, "another 20 units come off the same batch");
    await page.request.patch(api(page, `/marks/${second}`), { data: { op: "void", eventId: crypto.randomUUID(), reason: "Wrong patient" } });
    check((await onHand("SOON-27")) === 46, "voided, its 20 units go back to the batch");
    await page.request.post(api(page, "/marks"), {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "forehead", units: 200 }], product: { id: botox.id, qty: 200 } },
    });
    const total = Number((await q(`select coalesce(sum(qty), 0)::float as n from stock_moves where product_id = $1`, [botox.id]))[0].n);
    const owed = Number((await q(`select coalesce(sum(qty), 0)::float as n from stock_moves where product_id = $1 and batch_id is null`, [botox.id]))[0].n);
    check(total === -54 && owed === -54, "200 units with 146 on hand: it records, and 54 are owed", JSON.stringify({ total, owed }));
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 120000 });
    await page.waitForSelector("[data-stock]");
    check((await page.locator("[data-stock-alerts]").innerText()).includes("1 used with none on hand"), "the Stock page says one product was used with none on hand");
    await receive("1", "100", "NEW-28", "2028-01-31");
    check((await onHand("NEW-28")) === 46 && Number((await q(`select coalesce(sum(qty), 0)::float as n from stock_moves where product_id = $1 and batch_id is null`, [botox.id]))[0].n) === 0, "the next delivery settles it: 54 of its 100 were already used");

    /* ── Packages ───────────────────────────────────────────────────── */
    console.log("Packages");
    await page.goto(`${BASE}/c/${slug}/settings/face-packages`, { timeout: 120000 });
    await page.waitForSelector("[data-face-packages]", { timeout: 60000 });
    check((await page.locator("nav a", { hasText: "Face packages" }).count()) > 0, "Face packages has its place in Settings");
    await page.locator("[data-plan-new]").click();
    await page.locator("[data-plan-name]").fill("Laser upper lip × 6");
    await page.locator("[data-plan-price]").fill("150");
    await page.locator("[data-plan-save]").click();
    check(await until(async () => (await q(`select 1 from package_plans where clinic_id = $1 and name = 'Laser upper lip × 6' and price = 150`, [clinic.id])).length === 1), "a package of six laser sessions at 150");
    const plan = (await q(`select id from package_plans where clinic_id = $1 and name = 'Laser upper lip × 6'`, [clinic.id]))[0];
    check((await q(`select treatment_key, sessions from package_plan_items where plan_id = $1`, [plan.id]))[0]?.sessions === 6, "holding six sessions of laser hair removal");

    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-face-map]");
    await page.locator("[data-face-sell]").click();
    await page.locator(`[data-face-plan='${plan.id}']`).click();
    await page.getByRole("dialog").locator("textarea").fill("Paid in two instalments");
    await page.locator("[data-face-sell-save]").click();
    check(await until(async () => (await q(`select 1 from patient_packages where patient_id = $1`, [patient.id])).length === 1), "sold to the patient");
    const [pkg] = await q(`select pp.*, pp.price::float as price from patient_packages pp where patient_id = $1`, [patient.id]);
    const [sale] = await q(`select *, fee::float as fee from chart_marks where id = $1`, [pkg.sale_mark_id]);
    check(sale.fee === 150 && sale.performed_by === null, "as a face chart entry at 150, in nobody's name");
    check(await until(async () => (await page.locator(`[data-face-ready-item='${sale.id}']`).count()) === 1), "on Ready to bill");

    await page.locator("[data-zone='lips']").click();
    await page.locator("[data-face-treatment='aes_laser_hair']").click();
    await page.waitForSelector("[data-face-from-package]");
    check((await page.locator("[data-face-from-package]").getAttribute("aria-pressed")) === "true", "laser on the lip offers the package, session 1 of 6, already ticked");
    check((await page.locator("[data-face-fee]").getAttribute("data-face-fee")) === "0", "covered: nothing more to bill");
    await page.locator("[data-face-doer]").selectOption(doc.id);
    await page.locator("[data-face-save]").click();
    check(await until(async () => (await marksOf("aes_laser_hair")).length === 1), "the session is saved");
    const [session] = await marksOf("aes_laser_hair");
    check(session.fee === 0 && !!session.package_item_id && Number(session.commission_percent) === 40 && session.costs_rule === "shared", "at no charge, from the package, the doctor's 40% frozen on it");
    check(await until(async () => (await page.locator(`[data-face-package] [data-used='1']`).count()) === 1), "the package shows 1 of 6 used");
    check((await page.locator(`[data-face-ready-item='${session.id}']`).count()) === 0, "and the session is not on Ready to bill");

    // Billed and paid: the session earns its part.
    await page.goto(`${BASE}/c/${slug}/invoices/new?patient=${patient.id}&marks=${sale.id}`, { timeout: 120000 });
    await until(async () => (await lineValues(page)).includes("Laser upper lip × 6"), 60000);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60000 });
    const inv2 = new URL(page.url()).pathname.split("/").pop()!;
    check((await q(`select 1 from invoice_line_doctors d join invoice_items ii on ii.id = d.invoice_item_id where ii.invoice_id = $1`, [inv2])).length === 0, "the package's line names no doctor");
    await q(`insert into payments (clinic_id, invoice_id, patient_id, amount, method) values ($1, $2, $3, 150, 'cash')`, [clinic.id, inv2, patient.id]);
    await q(`update invoices set amount_paid = 150, status = 'paid' where id = $1`, [inv2]);
    const share2 = await earningsForDoctor(c, scope, doc.id);
    check(Math.abs(share2.earned - share1.earned - 10) < 0.005, "the session done earns its doctor 150 ÷ 6 × 40% = 10", JSON.stringify(share2));
    const voidPkg = await page.request.patch(api(page, `/marks/${sale.id}`), { data: { op: "void", eventId: crypto.randomUUID() } });
    check(voidPkg.status() === 409, "a package whose sessions are in use cannot be voided", String(voidPkg.status()));

    // A bundle, split by the list.
    const [bundle] = await q(`insert into package_plans (clinic_id, name, price) values ($1, 'Toxin and filler', 350) returning id`, [clinic.id]);
    await q(`insert into package_plan_items (clinic_id, plan_id, treatment_key, sessions, sort) values ($1, $2, 'aes_toxin', 1, 0), ($1, $2, 'aes_filler', 1, 1)`, [clinic.id, bundle.id]);
    const sold = await page.request.post(api(page, "/packages"), { data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), planId: bundle.id } });
    check(sold.status() === 200, "a bundle sells");
    const split = await q(
      `select i.treatment_key, i.value::float as value from patient_package_items i join patient_packages pp on pp.id = i.patient_package_id
        where pp.plan_id = $1 order by i.sort`,
      [bundle.id]
    );
    check(split[0]?.value === 111.36 && split[1]?.value === 238.64, "its 350 split by the list's 70 and 150: 111.36 and 238.64", JSON.stringify(split));

    /* ── Notes ──────────────────────────────────────────────────────── */
    console.log("Notes");
    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-face-map]");
    await page.locator(`[data-face-note='${session.id}']`).click();
    await page.locator(`[data-face-entry='${session.id}'] textarea`).fill("Mild redness after, settled in an hour");
    await page.locator(`[data-face-note-save='${session.id}']`).click();
    check(await until(async () => (await q(`select note from chart_marks where id = $1`, [session.id]))[0].note === "Mild redness after, settled in an hour"), "a note is edited on a treatment");
    await page.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=notes`, { timeout: 120000 });
    check(
      await until(async () => (await page.locator(`[data-feed-key='face:${session.id}']`).innerText().catch(() => "")).includes("Mild redness after"), 30000),
      "the edited note is in the patient's Notes"
    );
    check((await page.locator(`[data-feed-key='face:${sale.id}']`).innerText().catch(() => "")).includes("Paid in two instalments"), "and so is the note written when the package was sold");
    check((await page.locator(`[data-feed-key='face:${toxin.id}']`).innerText().catch(() => "")).includes("Botox batch SOON-27"), "and the toxin's");

    check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
