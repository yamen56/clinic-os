/**
 * Stock reaches the people who order it, and the rest of the app (2026-11-07,
 * "make everything more connected").
 *
 * - The worker's licence list agrees with the app's, so a dental clinic is not
 *   told about face chart stock.
 * - Running low, run out, expiring and expired reach the owner and the desk who
 *   keep Stock, once each: a second pass says nothing, a new delivery that runs
 *   low again is news again.
 * - The dashboard shows what needs attention; an expense from a delivery points
 *   back to Stock and says so before it is deleted; a renamed product renames its
 *   prices; the chart names the lot a patient received; a company shows what was
 *   bought from it; Stock and its prices link to each other.
 *
 * Run against a warm server.
 */
import "../worker/env";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { stockAlerts } from "../worker/stock-alerts";
import { OPT_IN } from "../worker/features";
import { OPT_IN_FEATURES } from "../src/lib/features";

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
    await new Promise((r) => setTimeout(r, 200));
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
  console.log("The worker's licence list");
  check(
    [...OPT_IN].sort().join() === [...OPT_IN_FEATURES].sort().join(),
    "the worker and the app agree on which modules are opt-in",
    `${[...OPT_IN].sort().join()} vs ${[...OPT_IN_FEATURES].sort().join()}`
  );

  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);

  const clinicOf = async (slug: string, features: string) => {
    const [cl] = await q(`insert into clinics (name, slug, features, timezone) values ('QA Alerts', $1, $2, 'Asia/Amman') returning id`, [slug, features]);
    await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [cl.id]);
    await q(`select seed_expense_categories($1)`, [cl.id]);
    return cl.id as string;
  };
  const slug = `qaalerts${tag}`;
  const clinic = await clinicOf(slug, '{"aesthetic": true}');
  const dental = await clinicOf(`qaalertsdent${tag}`, '{"dental": true}');

  const member = async (clinicId: string, who: string, role: string, permissions: string, isOwner = false) => {
    const email = `${who}-${tag}@test.local`;
    const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, hash, who]);
    await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, $3, $4, $5)`, [clinicId, u.id, role, isOwner, permissions]);
    return { email, userId: u.id as string };
  };
  const owner = await member(clinic, "owner", "doctor", '{"level":"full"}', true);
  const desk = await member(clinic, "desk", "receptionist", JSON.stringify({ level: "custom", caps: { dashboard: true, stock: true, invoices: true, expenses: true } }));
  const deskNoStock = await member(clinic, "desknostock", "receptionist", JSON.stringify({ level: "custom", caps: { dashboard: true, calendar: true } }));
  const doctor = await member(clinic, "doctor", "doctor", JSON.stringify({ level: "custom", caps: { dashboard: true, patients: true, "patients.charts": true, stock: true } }));
  const dentalOwner = await member(dental, "dentalowner", "doctor", '{"level":"full"}', true);

  const product = async (clinicId: string, name: string, low: number | null) =>
    (
      await q(
        `insert into aesthetic_products (clinic_id, name, treatments, unit, pack_size, low_stock, last_cost) values ($1, $2, '{aes_toxin}', 'u', 100, $3, 1) returning id`,
        [clinicId, name, low]
      )
    )[0].id as string;
  const deliver = async (clinicId: string, productId: string, qty: number, lot: string, expires: string | null) => {
    const [b] = await q(
      `insert into stock_batches (clinic_id, product_id, lot, expires_on, qty, unit_cost, received_on) values ($1, $2, $3, $4, $5, 1, current_date) returning id`,
      [clinicId, productId, lot, expires, qty]
    );
    await q(`insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost) values ($1, $2, $3, 'receive', $4, 1)`, [clinicId, productId, b.id, qty]);
    return b.id as string;
  };
  const alerts = async (userId: string) =>
    q(`select title, body, url from notifications where user_id = $1 and kind = 'stock_alert' order by created_at`, [userId]);

  const botox = await product(clinic, "Botox 100u", 50);
  await deliver(clinic, botox, 40, "LOW-1", null);
  const filler = await product(clinic, "Juvederm Voluma", null);
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await deliver(clinic, filler, 10, "SOON-9", soon);
  const dentalProduct = await product(dental, "Dental Botox", 50);
  await deliver(dental, dentalProduct, 10, "D-1", null);

  console.log("Who is told");
  await stockAlerts({ force: true });
  const ownerSaw = await alerts(owner.userId);
  check(ownerSaw.length === 1, "the owner is told once", String(ownerSaw.length));
  check(ownerSaw[0]?.title === "Stock: 2 things need attention", "two things at once are one notification", ownerSaw[0]?.title);
  check(
    ownerSaw[0]?.body.includes("Botox 100u is running low: 40u left") && ownerSaw[0]?.body.includes("Juvederm Voluma SOON-9 expires"),
    "naming what is low and what is about to expire",
    ownerSaw[0]?.body.replace(/\n/g, " | ")
  );
  check(ownerSaw[0]?.url === `/c/${slug}/stock`, "and opening it opens Stock");
  check((await alerts(desk.userId)).length === 1, "the desk that keeps Stock is told");
  check((await alerts(deskNoStock.userId)).length === 0, "the desk that does not keep Stock is not");
  check((await alerts(doctor.userId)).length === 0, "a doctor is not paged about ordering");
  check((await alerts(dentalOwner.userId)).length === 0, "a dental clinic is not told about face chart stock");

  console.log("Once, until it happens again");
  await stockAlerts({ force: true });
  check((await alerts(owner.userId)).length === 1, "a second pass says nothing new");
  const second = await deliver(clinic, botox, 100, "LOW-2", null);
  await stockAlerts({ force: true });
  check((await alerts(owner.userId)).length === 1, "a delivery that brings it back above the line is not news");
  await q(`insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost) values ($1, $2, $3, 'adjust', -140, 1)`, [clinic, botox, second]);
  await stockAlerts({ force: true });
  const again = await alerts(owner.userId);
  check(again.length === 2 && again[1].title === "Botox 100u has run out", "run down again after that delivery, it is news again", again[1]?.title);

  console.log("Across the app");
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Lina Alerts', '+962790005151', 'staff') returning id`, [clinic]);
  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const page = await signIn(browser, owner.email);
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${BASE}/c/${slug}`, { timeout: 180000 });
    await page.waitForSelector("[data-stock-card]", { timeout: 120000 });
    const card = await page.locator("[data-stock-card]").innerText();
    check(card.includes("Botox 100u") && card.includes("None left") && card.includes("SOON-9"), "the dashboard shows what needs attention", card.replace(/\n/g, " | "));

    // A delivery through the page, so it has an expense.
    const lidocaine = await product(clinic, "Lidocaine cream", null);
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 180000 });
    await page.waitForSelector("[data-stock]");
    check((await page.locator("[data-stock-prices]").count()) === 1, "Stock links to its prices");
    await page.locator(`[data-stock-product='${lidocaine}']`).getByRole("button", { name: "Receive stock" }).click();
    await page.locator("[data-receive-packs]").fill("1");
    await page.locator("[data-receive-price]").fill("35");
    await page.locator("[data-receive-lot]").fill("LID-4");
    await page.locator("[data-receive-save]").click();
    check(await until(async () => (await q(`select 1 from stock_batches where product_id = $1 and expense_id is not null`, [lidocaine])).length === 1), "a delivery records its expense");

    await page.goto(`${BASE}/c/${slug}/expenses`, { timeout: 180000 });
    const pill = page.locator("[data-expense-stock]", { hasText: "Lidocaine cream" });
    await pill.waitFor({ timeout: 60000 });
    check((await pill.innerText()).includes("Delivery of Lidocaine cream"), "the expense says which delivery it paid for");
    check((await pill.getAttribute("href"))?.endsWith(`/c/${slug}/stock`), "and points back to Stock");
    await pill.locator("xpath=ancestor::tr[1]").getByRole("button", { name: /delete/i }).click();
    check(await until(async () => (await page.locator("body").innerText()).includes("The delivery stays on hand in Stock")), "deleting it says the delivery stays");
    await page.keyboard.press("Escape");

    console.log("Prices, lots and companies");
    await q(
      `insert into services (clinic_id, name, name_ar, price, chart_key, chart_variant, chart_owned, price_unit) values ($1, 'Toxin (Botox 100u)', 'توكسين (Botox 100u)', 80, 'aes_toxin', $2, true, 'item')`,
      [clinic, botox]
    );
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 180000 });
    await page.waitForSelector("[data-stock]");
    await page.locator(`[data-stock-product='${botox}']`).getByRole("button", { name: "Edit" }).click();
    await page.locator("[data-product-name]").fill("Botox 50u");
    await page.locator("[data-product-save]").click();
    const renamed = await until(async () => ((await q(`select name from services where chart_variant = $1`, [botox]))[0]?.name ?? "").endsWith("(Botox 50u)"));
    check(
      renamed,
      "renaming a product renames its price",
      JSON.stringify({
        product: (await q(`select name from aesthetic_products where id = $1`, [botox]))[0]?.name,
        services: await q(`select name, chart_key, chart_owned, chart_variant from services where clinic_id = $1`, [clinic]),
      })
    );

    const [co] = await q(`insert into aesthetic_companies (clinic_id, name) values ($1, 'Allergan QA') returning id`, [clinic]);
    await q(`update aesthetic_products set company_id = $2 where id = $1`, [filler, co.id]);
    await page.reload();
    await page.waitForSelector("[data-stock]");
    await page.getByRole("button", { name: "Companies" }).click();
    const summary = await page.locator(`[data-company='${co.id}'] [data-company-summary]`).innerText();
    check(summary.includes("1 products") && summary.includes("10"), "a company shows what has been bought from it", summary);
    await page.keyboard.press("Escape");

    await q(`update aesthetic_products set treatments = '{aes_filler}' where id = $1`, [filler]);
    await deliver(clinic, filler, 5, "LOT-77", null);
    const res = await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/face/marks`, {
      data: { id: randomUUID(), eventId: randomUUID(), treatmentKey: "aes_filler", areas: [{ zone: "lips" }], count: 1, product: { id: filler, qty: 1 } },
    });
    const took = await q(`select b.lot from stock_moves m join stock_batches b on b.id = m.batch_id where b.product_id = $1 and m.kind = 'use'`, [filler]);
    check(res.ok() && took.length > 0, "a filler treatment takes from a lot", `${res.status()} ${(await res.text()).slice(0, 200)}`);
    await page.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=face`, { timeout: 180000 });
    const entry = page.locator("[data-face-entry]").first();
    await entry.waitFor({ timeout: 120000 });
    check(/SOON-9|LOT-77/.test(await entry.innerText()), "the chart names the lot the patient received", (await entry.innerText()).replace(/\n/g, " | "));

    await page.goto(`${BASE}/c/${slug}/settings/face-prices`, { timeout: 180000 });
    await page.waitForSelector("[data-face-prices]", { timeout: 120000 });
    check((await page.locator("[data-face-prices-stock]").count()) === 1, "and the prices link back to Stock");

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    for (const id of [clinic, dental]) await q(`delete from clinics where id = $1`, [id]).catch((e) => console.log("cleanup:", e.message));
    await q(`delete from users where email like $1`, [`%-${tag}@test.local`]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
