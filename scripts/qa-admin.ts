/**
 * The rebuilt agency admin (2026-11-27).
 *
 * - Overview: the figures, and "Needs you" naming a trial that ends this week.
 * - Clinics: search finds an Arabic name however its alef and ta marbuta are
 *   typed; "Needs attention" narrows to it.
 * - New clinic, in steps: an owner who already has an account is told so
 *   before the clinic is made; a Doctor-plan clinic gets its two seats, no
 *   signing links, the owner as its doctor, a trial end date and an address,
 *   and the plan's starting price is prefilled from Admin → Plans.
 * - A clinic's tabs: Details saves an address, Plan & billing moves it to
 *   Clinic Pro and writes the preset, Members shows the other clinic the same
 *   login opens and hands ownership over, Activity lists what the agency did.
 * - What left: the Default flows card, and every specialty pack but
 *   psychiatry's discreet reminder.
 *
 * Run against a warm server:  npx tsx scripts/qa-admin.ts
 */
import "../worker/env";
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

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
async function until(fn: () => Promise<boolean>, ms = 20000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const adminEmail = `qa-admin-${tag}@makan.agency`;
  const ownerEmail = `qa-admin-owner-${tag}@test.local`;
  const newSlug = `qa-adm-new-${tag}`;
  const made: string[] = [];

  await q(
    `insert into users (email, password_hash, full_name, locale, is_super_admin, admin_permissions) values ($1, $2, 'QA Agency', 'en', true, '{"level":"full"}')`,
    [adminEmail, hash]
  );
  // A clinic the new owner already works at, on trial and ending in three days.
  const existing = await one(
    `insert into clinics (name, name_ar, slug, plan, timezone, subscription_status, trial_ends_at)
     values ('QA Amal', 'عيادة الأمل', $1, 'clinic_plus', 'Asia/Amman', 'trial', now() + interval '3 days') returning id`,
    [`qa-adm-old-${tag}`]
  );
  made.push(existing.id);
  const owner = await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`, [ownerEmail, hash]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}')`, [existing.id, owner.id]);
  await q(`insert into plan_defaults (plan, price) values ('doctor', 25) on conflict (plan) do update set price = 25`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.fill('input[name="email"]', adminEmail);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 180000 });

    console.log("Overview");
    await page.goto(`${BASE}/admin`, { timeout: 180000 });
    await page.waitForSelector("[data-admin-figures]", { timeout: 90000 });
    const needs = await page.locator("[data-needs]").innerText().catch(() => "");
    check(needs.includes("QA Amal") || needs.includes("عيادة الأمل"), "Needs you names the trial that ends this week", needs.slice(0, 200));
    check((await page.locator('[data-need="trial_ending"]').count()) > 0, "…as a trial ending");

    console.log("Clinics");
    await page.goto(`${BASE}/admin/clinics`, { timeout: 180000 });
    await page.waitForSelector("[data-clinic-search]", { timeout: 90000 });
    await page.fill("[data-clinic-search]", "عياده الامل");
    check(
      await until(async () => (await page.locator(`[data-clinic-row="qa-adm-old-${tag}"]`).count()) === 1),
      "search finds the Arabic name typed with ه and plain alef"
    );
    await page.fill("[data-clinic-search]", "");
    await page.click("[data-filter-attention]");
    check(await until(async () => (await page.locator(`[data-clinic-row="qa-adm-old-${tag}"]`).count()) === 1), "Needs attention keeps the clinic whose trial ends");

    console.log("New clinic, in steps");
    await page.goto(`${BASE}/admin/clinics/new`, { timeout: 180000 });
    await page.waitForSelector('input[name="slug"]', { timeout: 90000 });
    await page.fill('input[name="name"]', "QA Wizard Clinic");
    await page.fill('input[name="slug"]', newSlug);
    await page.fill('input[name="address"]', "Abdoun, Amman");
    await page.click("[data-next-step]");
    await page.click("[data-next-step]");
    await page.click('[data-plan-card="doctor"]');
    check((await page.locator('input[name="planPrice"]').inputValue()) === "25", "the Doctor plan's starting price is prefilled");
    await page.click("[data-next-step]");
    await page.fill('input[name="ownerName"]', "QA Owner");
    await page.fill('input[name="ownerEmail"]', ownerEmail);
    await page.locator('input[name="ownerEmail"]').blur();
    check(
      await until(async () => (await page.locator("[data-owner-exists]").innerText().catch(() => "")).includes("عيادة الأمل")),
      "an owner who already uses Clinicti is told which clinic, before it is made"
    );
    await page.click("[data-next-step]");
    await page.click("[data-create-clinic]");
    await page.waitForURL(`**/admin/clinics/${newSlug}`, { timeout: 60000 });
    const nc = await one(
      `select id, plan, member_limit, features, address, subscription_status, trial_ends_at, plan_price from clinics where slug = $1`,
      [newSlug]
    );
    if (nc) made.push(nc.id);
    check(nc?.plan === "doctor" && nc?.member_limit === 2, "the clinic is on the Doctor plan with two seats", JSON.stringify({ plan: nc?.plan, limit: nc?.member_limit }));
    check(nc?.features?.esign_remote === false && nc?.features?.booking === false && nc?.features?.patients === true, "…its modules are the plan's");
    check(nc?.address === "Abdoun, Amman", "…its address was saved");
    check(
      nc?.subscription_status === "trial" && nc?.trial_ends_at && Math.abs(new Date(nc.trial_ends_at).getTime() - Date.now() - 14 * 86400000) < 86400000,
      "…on a fourteen-day trial"
    );
    const om = await one(`select role, is_owner from clinic_members where clinic_id = $1 and user_id = $2`, [nc?.id, owner.id]);
    check(om?.is_owner && om?.role === "doctor", "the owner joined as its doctor, on the account they already had");

    console.log("A clinic's tabs");
    await page.goto(`${BASE}/admin/clinics/${newSlug}?tab=details`, { timeout: 180000 });
    await page.waitForSelector("[data-details-form]", { timeout: 90000 });
    await page.fill('[data-detail="address"]', "Sweifieh, Amman");
    await page.click("[data-save-details]");
    check(
      await until(async () => (await one(`select address from clinics where slug = $1`, [newSlug]))?.address === "Sweifieh, Amman"),
      "Details saves the address"
    );
    check((await page.locator("text=Danger zone").count()) > 0, "the danger zone is at the foot of Details");

    await page.goto(`${BASE}/admin/clinics/${newSlug}?tab=plan`, { timeout: 180000 });
    await page.waitForSelector("[data-plan-billing]", { timeout: 90000 });
    await page.click('[data-plan-card="clinic_pro"]');
    await page.click("[data-save-plan]");
    check(
      await until(async () => {
        const r = await one(`select plan, member_limit, features from clinics where slug = $1`, [newSlug]);
        return r?.plan === "clinic_pro" && r?.member_limit === null && r?.features?.ai === true && r?.features?.branding === true;
      }),
      "Plan & billing moves it to Clinic Pro, with its modules and no user limit"
    );

    await page.goto(`${BASE}/admin/clinics/${newSlug}?tab=members`, { timeout: 180000 });
    await page.waitForSelector("[data-admin-members]", { timeout: 90000 });
    check(
      (await page.locator(`[data-admin-member="${ownerEmail}"] [data-elsewhere]`).innerText().catch(() => "")).includes("عيادة الأمل"),
      "Members shows the other clinic the owner's login opens"
    );
    check((await page.locator("[data-default-flows]").count()) === 0, "there is no Default flows card");

    await page.goto(`${BASE}/admin/clinics/${newSlug}?tab=activity`, { timeout: 180000 });
    await page.waitForSelector("[data-clinic-activity]", { timeout: 90000 });
    const act = await page.locator("[data-clinic-activity]").innerText();
    check(act.includes("admin.clinic.plan") && act.includes("admin.clinic.details") && act.includes("admin.clinic.create"), "Activity lists the plan change, the details and the creation", act.slice(0, 200));

    console.log("Plans");
    await page.goto(`${BASE}/admin/plans`, { timeout: 180000 });
    await page.waitForSelector('[data-plan-price="clinic_plus"]', { timeout: 90000 });
    await page.fill('[data-plan-price="clinic_plus"]', "40");
    await page.click("[data-save-prices]");
    check(await until(async () => Number((await one(`select price from plan_defaults where plan = 'clinic_plus'`))?.price) === 40), "Plans saves a starting price");

    console.log("What left");
    const packs = (await q(`select key from recipe_templates where active and specialty <> 'general'`)).map((r) => r.key as string);
    check(packs.length === 1 && packs[0] === "psych_discreet_reminder", "only psychiatry's discreet reminder is still offered by specialty", packs.join(","));
    check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = any($1::uuid[]) or slug = $2`, [made, newSlug]).catch(() => {});
    await q(`delete from users where email in ($1, $2)`, [adminEmail, ownerEmail]).catch(() => {});
    await q(`update plan_defaults set price = 0`).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
