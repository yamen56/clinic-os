/**
 * Branches, and one login across clinics (2026-11-27).
 *
 * - The agency opens a branch from the clinic's Branches tab with every part
 *   copied: the branch is in the clinic's group with the same plan, and has the
 *   main clinic's services, hours, forms and flows; the owner owns it and the
 *   chosen receptionist works there too, on the login she already has.
 * - A Doctor-plan clinic cannot have branches.
 * - The owner's switcher lists the branch; the report lists both with a total;
 *   the receptionist, without the takings in either, gets no report; signing
 *   in again returns to the clinic used last.
 * - A doctor's saved signature and photo outlive purging the clinic they were
 *   uploaded from (lib/account-files).
 *
 * Run against a warm server:  npx tsx scripts/qa-branches.ts
 */
import "../worker/env";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { toFeatureSetting } from "../src/lib/features";
import { planFeatures } from "../src/lib/plans";

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
async function until(fn: () => Promise<boolean>, ms = 30000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
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
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const mainSlug = `qa-br-${tag}`;
  const branchSlug = `qa-br-${tag}-north`;
  const docSlug = `qa-br-doc-${tag}`;
  const emails = [`qa-br-admin-${tag}@makan.agency`, `qa-br-owner-${tag}@test.local`, `qa-br-desk-${tag}@test.local`];
  const [adminEmail, ownerEmail, deskEmail] = emails;

  await q(`insert into users (email, password_hash, full_name, locale, is_super_admin, admin_permissions) values ($1, $2, 'QA Agency', 'en', true, '{"level":"full"}')`, [adminEmail, hash]);
  const owner = await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`, [ownerEmail, hash]);
  const desk = await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Desk', 'en') returning id`, [deskEmail, hash]);
  const main = await one(
    `insert into clinics (name, name_ar, slug, plan, features, timezone, default_locale, working_hours, brand_color)
     values ('QA Main', 'عيادة الفرع الرئيسي', $1, 'clinic_plus', $2, 'Asia/Amman', 'en', '{"sun":[["09:00","13:00"]]}', '#123456') returning id`,
    [mainSlug, JSON.stringify(toFeatureSetting(planFeatures("clinic_plus")))]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [main.id]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}')`, [main.id, owner.id]);
  await q(`insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'receptionist', '{"level":"custom","caps":{"calendar":true,"patients":true}}')`, [main.id, desk.id]);
  await q(`insert into services (clinic_id, name, duration_min, price, bookable_online) values ($1, 'QA Cleaning', 30, 25, true)`, [main.id]);
  await q(
    `insert into automations (clinic_id, name, trigger_type, trigger_config, active, settings, canvas, recipe_key) values ($1, 'QA flow', 'patient_created', '{}', true, '{}', '{"trigger": null}', null)`,
    [main.id]
  );
  const docClinic = await one(
    `insert into clinics (name, slug, plan, features, timezone) values ('QA Doc', $1, 'doctor', $2, 'Asia/Amman') returning id`,
    [docSlug, JSON.stringify(toFeatureSetting(planFeatures("doctor")))]
  );
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}')`, [docClinic.id, owner.id]);

  const browser = await chromium.launch();
  try {
    console.log("The agency opens a branch");
    const admin = await signIn(browser, adminEmail);
    await admin.goto(`${BASE}/admin/clinics/${docSlug}?tab=branches`, { timeout: 180000 });
    await admin.waitForSelector("[data-branch-list]", { timeout: 90000 });
    check((await admin.locator("[data-add-branch]").count()) === 0, "a Doctor-plan clinic is offered no branch");

    await admin.goto(`${BASE}/admin/clinics/${mainSlug}?tab=branches`, { timeout: 180000 });
    await admin.waitForSelector("[data-add-branch]", { timeout: 90000 });
    await admin.click("[data-add-branch]");
    await admin.fill("[data-branch-name]", "North");
    await admin.fill("[data-branch-slug]", branchSlug);
    await admin.getByLabel("QA Desk", { exact: false }).check();
    await admin.click("[data-create-branch]");
    await admin.waitForURL(`**/admin/clinics/${branchSlug}`, { timeout: 90000 });
    const br = await one(`select id, group_id, plan, working_hours, brand_color from clinics where slug = $1`, [branchSlug]);
    const mg = await one(`select group_id from clinics where id = $1`, [main.id]);
    check(br && mg?.group_id && br.group_id === mg.group_id, "the branch is in the clinic's group");
    check(br?.plan === "clinic_plus", "…on the same plan");
    check(JSON.stringify(br?.working_hours) === JSON.stringify({ sun: [["09:00", "13:00"]] }) && br?.brand_color === "#123456", "…with its hours and colour");
    check((await one(`select count(*)::int as n from services where clinic_id = $1 and name = 'QA Cleaning'`, [br?.id]))?.n === 1, "…its services and prices");
    check((await one(`select count(*)::int as n from automations where clinic_id = $1 and name = 'QA flow'`, [br?.id]))?.n === 1, "…and its flows");
    const ownerHere = await one(`select is_owner from clinic_members where clinic_id = $1 and user_id = $2`, [br?.id, owner.id]);
    const deskHere = await one(`select role, permissions from clinic_members where clinic_id = $1 and user_id = $2`, [br?.id, desk.id]);
    check(ownerHere?.is_owner, "the owner owns the branch");
    check(deskHere?.role === "receptionist" && deskHere?.permissions?.caps?.calendar === true, "the receptionist works there too, with the same access");

    console.log("One login, several clinics");
    const op = await signIn(browser, ownerEmail);
    await op.goto(`${BASE}/c/${mainSlug}`, { timeout: 180000 });
    await op.waitForSelector("[data-clinic-switcher]", { timeout: 90000 });
    await op.locator("[data-clinic-switcher]").first().click();
    check(await until(async () => (await op.locator(`[data-switch-to="${branchSlug}"]`).count()) > 0), "the owner's switcher lists the branch");
    await op.goto(`${BASE}/c/${mainSlug}/branches`, { timeout: 180000 });
    await op.waitForSelector("[data-branches-report]", { timeout: 90000 });
    check(
      (await op.locator(`[data-branch-row="${mainSlug}"]`).count()) === 1 && (await op.locator(`[data-branch-row="${branchSlug}"]`).count()) === 1,
      "the report has a row for each branch"
    );
    check((await op.locator("[data-branches-total]").count()) === 1, "…and a total");
    // Signing in again goes back to the clinic used last, not the picker.
    await op.goto(`${BASE}/c/${branchSlug}`, { timeout: 180000 });
    await op.waitForSelector("[data-clinic-switcher]", { timeout: 90000 });
    // The switcher records it once the page is live (an effect), not when the HTML arrives.
    await until(async () => (await op.context().cookies()).some((c) => c.name === "cos_last_clinic" && decodeURIComponent(c.value) === branchSlug));
    await op.goto(`${BASE}/`, { timeout: 180000 });
    check(await until(async () => new URL(op.url()).pathname === `/c/${branchSlug}`), "/ returns to the clinic used last", op.url());
    await op.goto(`${BASE}/?pick=1`, { timeout: 180000 });
    check(new URL(op.url()).pathname === "/", "…and ?pick=1 still shows every clinic");

    const dp = await signIn(browser, deskEmail);
    await dp.goto(`${BASE}/c/${mainSlug}/branches`, { timeout: 180000 });
    check(await until(async () => new URL(dp.url()).pathname !== `/c/${mainSlug}/branches`), "without the takings, the receptionist gets no report");

    console.log("Account files outlive a clinic");
    const { saveFile, readFileBuffer } = await import("../src/lib/storage");
    const { rescueAccountFiles } = await import("../src/lib/account-files");
    const old = await saveFile(main.id, "signatures/staff", `${owner.id}.png`, Buffer.from("qa-signature"));
    await q(`update users set signature_png_path = $2 where id = $1`, [owner.id, old.storagePath]);
    const moved = await rescueAccountFiles(main.id);
    const after = await one(`select signature_png_path from users where id = $1`, [owner.id]);
    check(moved >= 1 && String(after?.signature_png_path).startsWith(`_users/${owner.id}/`), "a signature filed under the clinic moves under the person", after?.signature_png_path);
    check(String(await readFileBuffer(after?.signature_png_path)) === "qa-signature", "…and reads back the same");
  } finally {
    await browser.close();
    await q(`delete from clinics where slug in ($1, $2, $3)`, [mainSlug, branchSlug, docSlug]).catch(() => {});
    await q(`delete from clinic_groups g where not exists (select 1 from clinics c where c.group_id = g.id)`).catch(() => {});
    await q(`delete from users where email = any($1::text[])`, [emails]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
