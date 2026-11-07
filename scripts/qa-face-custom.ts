/**
 * The clinic's own face treatments, and the kinds of each (0094).
 *
 * Yamen, 2026-11-07: the doctor should "be able to add more treatments other than
 * the added ones, with its possible variants".
 *
 * - A doctor adds a treatment at the chair, on the areas just picked, and records it.
 * - A kind of the work is added in place and recorded with the entry; the entry
 *   keeps how it counted, so renaming or archiving the treatment later changes no past entry.
 * - The kind can have its own price, which wins over the treatment's; what was
 *   recorded with no price takes it.
 * - The invoice line says which kind it was.
 * - The clinic's own treatments are offered for packages and products, and an
 *   archived one is no longer offered but still named on old entries.
 *
 * Run against a warm server.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { faceLineText } from "../src/lib/charts/face/catalog";

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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const slug = `qacustom${tag}`;
  const [clinic] = await q(`insert into clinics (name, slug, features, timezone) values ('QA Custom', $1, '{"aesthetic": true}', 'Asia/Amman') returning id`, [slug]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  const email = `custom-${tag}@test.local`;
  const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Dr Custom', 'en') returning id`, [email, bcrypt.hashSync("password123", 10)]);
  const [doc] = await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}') returning id`, [clinic.id, u.id]);
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Maya Custom', '+962790006161', 'staff') returning id`, [clinic.id]);

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
    const page: Page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((x) => !x.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });

    console.log("A treatment of the clinic's own, at the chair");
    const chart = `${BASE}/c/${slug}/patients/${patient.id}?tab=face`;
    await page.goto(chart, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    await page.locator("[data-zone='neck']").click();
    await page.locator("[data-face-add-treatment]").click();
    await page.locator("[data-face-new-name]").fill("Polynucleotides");
    await page.locator("[data-face-new-family]").selectOption("skin");
    await page.locator("[data-face-new-priced]").selectOption("session");
    await page.locator("[data-face-new-save]").click();
    await page.waitForSelector("[data-face-panel='record']", { timeout: 15000 });
    const [made] = await q(`select key, fits from aesthetic_treatments where clinic_id = $1`, [clinic.id]);
    check(made?.key?.startsWith("aes_c_"), "it is saved with a face chart key", made?.key);
    check(JSON.stringify(made?.fits) === '["neck"]', "on the areas the doctor picked", JSON.stringify(made?.fits));
    check((await page.locator("[data-face-panel='record'] h3").innerText()).includes("Polynucleotides"), "and the chart goes straight on to recording it");

    console.log("A kind of it");
    await page.locator("[data-face-variant-add]").click();
    await page.locator("[data-face-variant-name]").fill("Salmon DNA");
    await page.locator("[data-face-variant-save]").click();
    check(await until(async () => (await page.locator("[data-face-variant='Salmon DNA']").getAttribute("aria-pressed")) === "true"), "a kind is added in place, and chosen");
    await page.locator("[data-face-save]").click();
    check(await until(async () => (await q(`select 1 from chart_marks where clinic_id = $1 and treatment_key = $2`, [clinic.id, made.key])).length === 1), "the treatment is recorded");
    const [mark] = await q(`select id, label, label_ar, areas, quantity, detail, fee from chart_marks where clinic_id = $1 and treatment_key = $2`, [clinic.id, made.key]);
    check(mark.detail?.variant?.name === "Salmon DNA" && mark.detail?.pricedBy === "session", "with its kind and how it counted", JSON.stringify(mark.detail));
    check(mark.fee === null, "unpriced, as nothing has a price yet");

    console.log("Prices");
    await page.goto(`${BASE}/c/${slug}/settings/face-prices`, { timeout: 180000 });
    await page.waitForSelector("[data-face-prices]", { timeout: 120000 });
    check((await page.locator(`[data-face-price-row='${made.key}']`).count()) === 1, "the clinic's own treatment is on the price list");
    const [kind] = await q(`select id from aesthetic_treatment_variants where clinic_id = $1 and name = 'Salmon DNA'`, [clinic.id]);
    // The kind's price first: an entry of that kind takes it, not the treatment's.
    await page.locator(`[data-price-box='${made.key}:${kind.id}']`).fill("150");
    await page.locator(`[data-price-box='${made.key}:${kind.id}']`).press("Enter");
    check(await until(async () => Number((await q(`select fee from chart_marks where id = $1`, [mark.id]))[0].fee) === 150), "the waiting entry takes its kind's own price");
    await page.locator(`[data-price-box='${made.key}']`).fill("100");
    await page.locator(`[data-price-box='${made.key}']`).press("Enter");
    await until(async () => (await q(`select 1 from services where clinic_id = $1 and chart_key = $2 and chart_variant is null`, [clinic.id, made.key])).length === 1);
    check(Number((await q(`select fee from chart_marks where id = $1`, [mark.id]))[0].fee) === 150, "and the treatment's own price does not undercut it");
    const [svc] = await q(`select name from services where clinic_id = $1 and chart_variant = $2`, [clinic.id, kind.id]);
    check(svc?.name === "Polynucleotides (Salmon DNA)", "the kind's price is named after it", svc?.name);
    const plainLine = faceLineText({ treatmentKey: made.key, label: mark.label, labelAr: mark.label_ar, areas: mark.areas, quantity: Number(mark.quantity), detail: mark.detail }, null, "en");
    check(plainLine.startsWith("Polynucleotides (Salmon DNA) — Neck"), "an invoice line says which kind it was", plainLine);

    console.log("Elsewhere");
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 180000 });
    await page.waitForSelector("[data-stock]");
    await page.locator("[data-stock-new-product]").click();
    check((await page.locator(`[data-product-treatment='${made.key}']`).count()) === 1, "a product can be offered for it");
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/c/${slug}/settings/face-packages`, { timeout: 180000 });
    await page.getByRole("button", { name: /new/i }).first().click();
    check(await until(async () => (await page.locator(`option[value='${made.key}']`).count()) > 0), "and a package can include it");

    console.log("Archived");
    const r = await page.request.post(`${BASE}/api/c/${slug}/face/treatments`, { data: { op: "archive", key: made.key, archived: true } });
    check(r.ok(), "the treatment is archived");
    await page.goto(chart, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    check((await page.locator(`[data-face-entry='${mark.id}']`).first().innerText()).includes("Polynucleotides"), "its past entry still names it");
    await page.locator("[data-zone='neck']").click();
    check((await page.locator(`[data-face-treatment='${made.key}']`).count()) === 0, "but it is not offered any more");
    const again = await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: made.key, areas: [{ zone: "neck" }] },
    });
    check(again.status() === 400, "nor accepted", String(again.status()));
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]).catch((e) => console.log("cleanup:", e.message));
    await q(`delete from users where email = $1`, [email]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
