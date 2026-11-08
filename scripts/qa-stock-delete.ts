/**
 * Stock can be taken apart (0092).
 *
 * Yamen, 2026-11-07: "add more capabilities like delete". Deleting is one tap and
 * an Undo. What matters is what it must not do: a product a patient received, or a
 * delivery a treatment drew from, reaches back into charts and a doctor's share,
 * so those are archived or refused rather than removed.
 *
 * - A product nothing touched is really deleted, and its price with it; Undo brings
 *   both back. One with history is archived, and Restore returns it.
 * - A company with a product is archived; one with none is deleted.
 * - A delivery entered by mistake goes with its expense, unless the expense was
 *   changed by hand. One a treatment drew from cannot be deleted.
 * - A correction can be undone.
 * - Expired stock is taken last, the chart says when it is all that is left, and
 *   the unit a product is counted in is fixed once stock has moved.
 * - Voiding a treatment a delivery already settled gives the units back to the
 *   delivery, where a treatment can reach them.
 * - The badge and the page agree on what is running low.
 * - Somebody without Stock is not sent what the clinic pays for its products.
 *
 * Run against a warm server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { loadFaceChart } from "../src/lib/charts/face/db";

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

async function signIn(browser: Browser, email: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
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
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qadelete${tag}`;
  const [clinic] = await q(
    `insert into clinics (name, slug, specialty, features, timezone) values ('QA Delete', $1, 'dermatology', '{"aesthetic": true}', 'Asia/Amman') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);

  const member = async (who: string, name: string, permissions: string, isOwner = false) => {
    const email = `${who}-${tag}@test.local`;
    const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, hash, name]);
    const [m] = await q(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1, $2, 'doctor', $3, 'Dr.', $4) returning id`,
      [clinic.id, u.id, isOwner, permissions]
    );
    return { email, userId: u.id as string, memberId: m.id as string };
  };
  const owner = await member("owner", "Dr Owner", '{"level":"full"}', true);
  const stockOnly = await member("stockonly", "Stock Only", JSON.stringify({ level: "custom", caps: { dashboard: true, stock: true } }));

  const [patient] = await q(
    `insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Rana Delete', '+962790004343', 'staff') returning id`,
    [clinic.id]
  );

  const product = async (name: string, extra: { low?: number; company?: string } = {}) => {
    const [p] = await q(
      `insert into aesthetic_products (clinic_id, name, company_id, treatments, unit, pack_size, low_stock, last_cost)
       values ($1, $2, $3, '{aes_toxin}', 'u', 100, $4, 1) returning id`,
      [clinic.id, name, extra.company ?? null, extra.low ?? null]
    );
    return p.id as string;
  };
  const deliver = async (productId: string, qty: number, opts: { lot?: string; expires?: string | null; cost?: number } = {}) => {
    const [b] = await q(
      `insert into stock_batches (clinic_id, product_id, lot, expires_on, qty, unit_cost, received_on) values ($1, $2, $3, $4, $5, $6, current_date) returning id`,
      [clinic.id, productId, opts.lot ?? "", opts.expires ?? null, qty, opts.cost ?? 1]
    );
    await q(`insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost) values ($1, $2, $3, 'receive', $4, $5)`, [
      clinic.id,
      productId,
      b.id,
      qty,
      opts.cost ?? 1,
    ]);
    return b.id as string;
  };

  const browser = await chromium.launch();
  const errors: string[] = [];
  const stockUrl = `${BASE}/c/${slug}/stock`;
  try {
    const page = await signIn(browser, owner.email);
    page.on("pageerror", (e) => errors.push(e.message));
    const body = () => page.locator("body").innerText();
    const open = async () => {
      await page.goto(stockUrl, { timeout: 180000 });
      await page.waitForSelector("[data-stock]", { timeout: 120000 });
    };
    const undo = () => page.getByRole("button", { name: "Undo" }).click();
    const card = (id: string) => page.locator(`[data-stock-product='${id}']`);

    console.log("A product nothing has touched");
    const fresh = await product("Fresh Toxin");
    await q(
      `insert into services (clinic_id, name, price, chart_key, chart_variant, chart_owned, price_unit) values ($1, 'Fresh Toxin', 80, 'aes_toxin', $2, true, 'item')`,
      [clinic.id, fresh]
    );
    await open();
    await card(fresh).locator("[data-stock-delete]").click();
    check(await until(async () => (await card(fresh).count()) === 0), "it leaves the page on the tap");
    check(await until(async () => (await q(`select 1 from aesthetic_products where id = $1`, [fresh])).length === 0), "and it is really gone");
    check((await q(`select active from services where chart_variant = $1`, [fresh]))[0]?.active === false, "its own price stops being offered");
    await undo();
    check(await until(async () => (await q(`select 1 from aesthetic_products where id = $1 and active`, [fresh])).length === 1), "Undo brings it back, with the same id");
    check(await until(async () => (await card(fresh).count()) === 1), "and it is on the page again");
    check((await q(`select active from services where chart_variant = $1`, [fresh]))[0]?.active === true, "and so is its price");

    console.log("A product with history");
    const used = await product("Used Toxin");
    await deliver(used, 100);
    await open();
    await card(used).locator("[data-stock-delete]").click();
    check(await until(async () => (await q(`select 1 from aesthetic_products where id = $1 and not active`, [used])).length === 1), "it is archived, not deleted");
    check(await until(async () => (await body()).includes("moved to Archived")), "and the toast says so");
    check((await card(used).count()) === 0, "it leaves the main list");
    await page.locator("[data-stock-archived] button").first().click();
    await page.locator(`[data-stock-archived-product='${used}'] [data-stock-restore]`).click();
    check(await until(async () => (await q(`select 1 from aesthetic_products where id = $1 and active`, [used])).length === 1), "Restore returns it, however long it has been");

    console.log("Companies");
    const [emptyCo] = await q(`insert into aesthetic_companies (clinic_id, name) values ($1, 'Empty Co') returning id`, [clinic.id]);
    const [busyCo] = await q(`insert into aesthetic_companies (clinic_id, name) values ($1, 'Busy Co') returning id`, [clinic.id]);
    await product("Busy Product", { company: busyCo.id });
    await open();
    await page.getByRole("button", { name: "Companies" }).click();
    await page.locator(`[data-company='${emptyCo.id}'] [data-company-delete]`).click();
    check(await until(async () => (await q(`select 1 from aesthetic_companies where id = $1`, [emptyCo.id])).length === 0), "a company with no products is deleted");
    await page.locator(`[data-company='${busyCo.id}'] [data-company-delete]`).click();
    check(await until(async () => (await q(`select 1 from aesthetic_companies where id = $1 and not active`, [busyCo.id])).length === 1), "one a product names is archived");
    await page.locator(`[data-company='${busyCo.id}'] [data-company-edit]`).click();
    await page.locator("[data-company-note]").fill("Calls on Tuesdays");
    await page.locator("[data-company-add]").click();
    check(await until(async () => (await q(`select note from aesthetic_companies where id = $1`, [busyCo.id]))[0]?.note === "Calls on Tuesdays"), "a company can be edited, its note included");
    check((await q(`select active from aesthetic_companies where id = $1`, [busyCo.id]))[0].active === false, "and editing an archived one leaves it archived");
    await page.locator(`[data-company='${busyCo.id}'] [data-company-restore]`).click();
    check(await until(async () => (await q(`select 1 from aesthetic_companies where id = $1 and active`, [busyCo.id])).length === 1), "and it can be brought back");
    await page.keyboard.press("Escape");

    console.log("A delivery entered by mistake");
    const mistaken = await product("Mistaken Toxin");
    await open();
    await card(mistaken).getByRole("button", { name: "Receive stock" }).click();
    await page.locator("[data-receive-packs]").fill("2");
    await page.locator("[data-receive-price]").fill("120");
    await page.locator("[data-receive-lot]").fill("OOPS-1");
    const lastWeek = DateTime.now().setZone("Asia/Amman").minus({ days: 7 }).toISODate()!;
    await page.locator("[data-receive-on]").fill(lastWeek);
    await page.locator("[data-receive-save]").click();
    check(await until(async () => (await q(`select 1 from stock_batches where product_id = $1`, [mistaken])).length === 1), "received");
    const [batch] = await q(`select id, received_on::text as received_on, expense_id from stock_batches where product_id = $1`, [mistaken]);
    const [expense] = await q(`select amount::float as amount, spent_on::text as spent_on from expenses where id = $1`, [batch.expense_id]);
    check(batch.received_on === lastWeek && expense.spent_on === lastWeek, "a delivery entered late keeps the day it came, on the batch and the expense", JSON.stringify({ batch: batch.received_on, expense: expense.spent_on }));
    await card(mistaken).getByRole("button", { name: /Batches/ }).click();
    await page.locator(`[data-stock-batch='${batch.id}'] [data-batch-delete]`).click();
    check(await until(async () => (await q(`select 1 from stock_batches where id = $1`, [batch.id])).length === 0), "the delivery is deleted");
    check((await q(`select 1 from expenses where id = $1`, [batch.expense_id])).length === 0, "and the money it recorded with it");
    check(Number((await q(`select coalesce(sum(qty), 0) as n from stock_moves where product_id = $1`, [mistaken]))[0].n) === 0, "so nothing is left on hand");
    await undo();
    check(await until(async () => (await q(`select 1 from stock_batches where id = $1 and expense_id = $2`, [batch.id, batch.expense_id])).length === 1), "Undo restores the delivery, joined to its expense");
    check((await q(`select amount::float as amount, spent_on::text as spent_on from expenses where id = $1`, [batch.expense_id]))[0]?.amount === 240, "the expense comes back whole");
    check(Number((await q(`select coalesce(sum(qty), 0) as n from stock_moves where product_id = $1`, [mistaken]))[0].n) === 200, "and so do the units");

    await q(`update expenses set note = 'Checked against the invoice' where id = $1`, [batch.expense_id]);
    await open();
    await card(mistaken).getByRole("button", { name: /Batches/ }).click();
    await page.locator(`[data-stock-batch='${batch.id}'] [data-batch-delete]`).click();
    check(await until(async () => (await q(`select 1 from stock_batches where id = $1`, [batch.id])).length === 0), "a delivery whose expense was changed by hand can still be deleted");
    check((await q(`select 1 from expenses where id = $1`, [batch.expense_id])).length === 1, "but that expense stays");
    check(await until(async () => (await body()).includes("stays in Expenses")), "and the toast says so");

    console.log("A delivery a treatment drew from");
    const drawn = await product("Drawn Toxin");
    const drawnBatch = await deliver(drawn, 100, { lot: "DRAWN-1" });
    const faceApi = `${BASE}/api/c/${slug}/patients/${patient.id}/face`;
    const treat = (productId: string, qty: number) =>
      page.request.post(`${faceApi}/marks`, {
        data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "forehead", units: qty }], product: { id: productId, qty } },
      });
    check((await treat(drawn, 10)).ok(), "a treatment takes 10 units");
    await open();
    await card(drawn).getByRole("button", { name: /Batches/ }).click();
    check((await page.locator(`[data-stock-batch='${drawnBatch}'] [data-batch-delete]`).count()) === 0, "its delivery offers no delete");

    console.log("Undoing a correction");
    await page.locator(`[data-stock-batch='${drawnBatch}']`).getByRole("button", { name: "Correct" }).click();
    await page.locator("[data-adjust-on-hand]").fill("80");
    await page.locator("[data-adjust-save]").click();
    const left = async () => Number((await q(`select coalesce(sum(qty), 0)::float as n from stock_moves where batch_id = $1`, [drawnBatch]))[0].n);
    check(await until(async () => (await left()) === 80), "a count is corrected from 90 to 80");
    await undo();
    check(await until(async () => (await left()) === 90), "and taken back");

    console.log("History");
    await open();
    await card(drawn).locator("[data-stock-history]").click();
    await page.waitForSelector("[data-stock-moves]");
    const lines = await page.locator("[data-stock-moves]").innerText();
    check(lines.includes("Delivery") && lines.includes("Used") && lines.includes("DRAWN-1"), "a product's history shows what came in and what was used, by lot");
    check(lines.includes("Rana Delete"), "and which patient received it");
    await page.keyboard.press("Escape");

    const limited = await signIn(browser, stockOnly.email);
    await limited.goto(stockUrl, { timeout: 180000 });
    await limited.waitForSelector("[data-stock]", { timeout: 120000 });
    await limited.locator(`[data-stock-product='${drawn}'] [data-stock-history]`).click();
    await limited.waitForSelector("[data-stock-moves]");
    const seen = await limited.locator("[data-stock-moves]").innerText();
    check(seen.includes("Used") && !seen.includes("Rana Delete"), "somebody with Stock but not Patients sees the movement, not the name");
    await limited.context().close();

    console.log("Expired stock");
    const yesterday = DateTime.now().setZone("Asia/Amman").minus({ days: 1 }).toISODate()!;
    const nextYear = DateTime.now().setZone("Asia/Amman").plus({ years: 1 }).toISODate()!;
    const today = DateTime.now().setZone("Asia/Amman").toISODate()!;
    const mixed = await product("Mixed Toxin");
    const oldBatch = await deliver(mixed, 30, { lot: "OLD", expires: yesterday, cost: 2 });
    const goodBatch = await deliver(mixed, 30, { lot: "GOOD", expires: nextYear, cost: 3 });
    const todayBatch = await deliver(mixed, 5, { lot: "TODAY", expires: today, cost: 4 });
    await treat(mixed, 10);
    const moved = async (id: string) => Number((await q(`select coalesce(sum(qty), 0)::float as n from stock_moves where batch_id = $1`, [id]))[0].n);
    check((await moved(oldBatch)) === 30, "the expired batch is passed over", String(await moved(oldBatch)));
    check((await moved(todayBatch)) === 0 && (await moved(goodBatch)) === 25, "the batch expiring today goes first, then the next", JSON.stringify([await moved(todayBatch), await moved(goodBatch)]));
    await open();
    check((await card(mixed).locator("[data-stock-expired]").getAttribute("data-stock-expired")) === "30", "the card says how much has expired");

    const stale = await product("Stale Toxin");
    const staleBatch = await deliver(stale, 20, { lot: "STALE", expires: yesterday });
    await page.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=face`, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    // Beside each part's middle: work recorded there earlier, by the API, is a dot in the middle, and a tap on it opens it.
    for (const z of ["forehead", "glabella", "crows_r", "crows_l"]) {
      const el = page.locator(`[data-zone='${z}']`);
      const b = (await el.boundingBox())!;
      await el.click({ position: { x: b.width / 2 + 12, y: b.height / 2 } });
    }
    await page.locator("[data-face-treatment='aes_toxin']").click();
    await page.waitForSelector("[data-face-panel='record']");
    check((await page.locator(`[data-face-product='${stale}'] [data-face-product-expired]`).count()) === 1, "the chart warns when expired stock is all that is left");
    check((await treat(stale, 5)).ok(), "and what the doctor says was used is still recorded");
    check((await moved(staleBatch)) === 15, "against the batch it came from");

    console.log("What a product is counted in");
    await open();
    await card(drawn).getByRole("button", { name: "Edit" }).click();
    check(await page.locator("[data-product-unit]").isDisabled(), "the unit is fixed once stock has moved");
    await page.keyboard.press("Escape");
    const unmoved = await product("Unmoved Toxin");
    await open();
    await card(unmoved).getByRole("button", { name: "Edit" }).click();
    check(!(await page.locator("[data-product-unit]").isDisabled()), "and open until then");
    await page.keyboard.press("Escape");

    console.log("A void after a delivery settled it");
    const short = await product("Short Toxin");
    const shortMark = crypto.randomUUID();
    await page.request.post(`${faceApi}/marks`, {
      data: { id: shortMark, eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "forehead", units: 20 }], product: { id: short, qty: 20 } },
    });
    await open();
    await card(short).getByRole("button", { name: "Receive stock" }).click();
    await page.locator("[data-receive-packs]").fill("1");
    await page.locator("[data-receive-price]").fill("100");
    await page.locator("[data-receive-save]").click();
    check(await until(async () => (await q(`select 1 from stock_batches where product_id = $1`, [short])).length === 1), "20 units used with none on hand, then a delivery of 100");
    const [shortBatch] = await q(`select id from stock_batches where product_id = $1`, [short]);
    check((await moved(shortBatch.id)) === 80, "which settles them: 80 left in it");
    await page.request.patch(`${faceApi}/marks/${shortMark}`, { data: { op: "void", eventId: crypto.randomUUID(), reason: "Wrong patient" } });
    check(await until(async () => (await moved(shortBatch.id)) === 100), "voided, all 100 are back in the delivery", String(await moved(shortBatch.id)));
    const stranded = Number((await q(`select coalesce(sum(qty), 0)::float as n from stock_moves where product_id = $1 and batch_id is null`, [short]))[0].n);
    check(stranded === 0, "and none are left where no treatment can reach them", String(stranded));

    console.log("What counts as running low");
    await q(`delete from chart_mark_products where clinic_id = $1`, [clinic.id]);
    await q(`update aesthetic_products set active = false where clinic_id = $1`, [clinic.id]);
    await product("Never Stocked");
    const runOut = await product("Run Out");
    await deliver(runOut, 10);
    await q(`insert into stock_moves (clinic_id, product_id, kind, qty) values ($1, $2, 'adjust', -10)`, [clinic.id, runOut]);
    const warned = await product("Warned", { low: 50 });
    await deliver(warned, 40);
    const plenty = await product("Plenty", { low: 5 });
    await deliver(plenty, 40);
    await open();
    const badge = await page.locator(`nav a[href$='/stock']`).first().innerText();
    check(badge.includes("2"), "the nav badge counts the two that need stock, not the one that never had any", badge.replace(/\n/g, " "));
    check((await page.locator("[data-stock-alerts]").innerText()).includes("2 running low"), "and the page says the same");

    console.log("What the chart is sent");
    const c = db as unknown as PoolClient;
    const costed = await loadFaceChart(c, clinic.id, patient.id, { billing: false, stockCosts: true });
    const plain = await loadFaceChart(c, clinic.id, patient.id, { billing: false, stockCosts: false });
    const has = costed.products.find((p) => p.id === warned)!;
    const hasnt = plain.products.find((p) => p.id === warned)!;
    check(has.lastCost === 1 && has.batches[0].unitCost === 1, "somebody with Stock is sent what a product costs");
    check(hasnt.lastCost === null && hasnt.batches[0].unitCost === 0, "somebody without it is not");
    check(hasnt.usable === 40 && hasnt.name === "Warned", "but still gets what the chart needs");

    console.log("On a phone");
    const phone = await signIn(browser, owner.email, { width: 390, height: 844 });
    await phone.goto(stockUrl, { timeout: 180000 });
    await phone.waitForSelector("[data-stock]", { timeout: 120000 });
    const width = (await phone.evaluate("document.documentElement.scrollWidth")) as number;
    check(width <= 390, "the page does not scroll sideways", String(width));
    await phone.context().close();

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]).catch((e) => console.log("cleanup:", e.message));
    await q(`delete from users where email like $1`, [`%-${tag}@test.local`]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
