/**
 * Clinic Pro's own branding (2026-11-27, lib/white-label).
 *
 * The same pages for a Clinic+ clinic and a Clinic Pro one:
 * - the booking page and a public invoice carry Clinicti's credit and title on
 *   Clinic+, and neither on Pro — while Pro keeps the privacy notice;
 * - the Pro workspace's tab title and sidebar name the clinic, not Clinicti;
 * - Pro's installed-app manifest is the clinic's, Clinic+ is sent to Clinicti's.
 *
 * Run against a warm server:  npx tsx scripts/qa-white-label.ts
 */
import "../worker/env";
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { toFeatureSetting } from "../src/lib/features";
import { planFeatures, type Plan } from "../src/lib/plans";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const CREDIT = 'a[href="https://clinicti.app"]';
const PRIVACY = 'a[href="https://privacy.clinicti.app"]';

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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const tag = Date.now().toString(36);
  const ownerEmail = `qa-wl-owner-${tag}@test.local`;
  const owner = await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`, [
    ownerEmail,
    bcrypt.hashSync("password123", 10),
  ]);

  const make = async (plan: Plan) => {
    const slug = `qa-wl-${plan === "clinic_pro" ? "pro" : "plus"}-${tag}`;
    const name = plan === "clinic_pro" ? "Amal Smile Studio" : "QA Plus Clinic";
    const cl = await one(
      `insert into clinics (name, slug, plan, features, default_locale, timezone) values ($1, $2, $3, $4, 'en', 'Asia/Amman') returning id`,
      [name, slug, plan, JSON.stringify(toFeatureSetting(planFeatures(plan)))]
    );
    await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [cl.id]);
    await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}')`, [cl.id, owner.id]);
    await q(`insert into services (clinic_id, name, duration_min, price, bookable_online) values ($1, 'Visit', 30, 10, true)`, [cl.id]);
    await q(`insert into booking_links (clinic_id, slug, name, active) values ($1, $2, 'Main', true)`, [cl.id, slug]);
    const p = await one(`insert into patients (clinic_id, full_name, phone_e164) values ($1, 'WL Patient', '+962790000222') returning id`, [cl.id]);
    const token = randomUUID().replace(/-/g, "");
    const inv = await one(
      `insert into invoices (clinic_id, patient_id, seq, number, status, currency, subtotal, total, amount_paid, public_token)
       values ($1, $2, 1, $3, 'sent', 'JOD', 50, 50, 0, $4) returning id`,
      [cl.id, p.id, `WL-${plan}-${tag}`, token]
    );
    await q(`insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount) values ($1, $2, 'Consultation', 1, 50, 50)`, [cl.id, inv.id]);
    return { id: cl.id as string, slug, name, token };
  };
  const plus = await make("clinic_plus");
  const pro = await make("clinic_pro");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page: Page = await ctx.newPage();
  const visit = async (url: string) => {
    await page.goto(url, { waitUntil: "networkidle", timeout: 180000 });
    return { credit: await page.locator(CREDIT).count(), privacy: await page.locator(PRIVACY).count(), title: await page.title() };
  };
  try {
    console.log("Booking page");
    const bPlus = await visit(`${BASE}/book/${plus.slug}`);
    const bPro = await visit(`${BASE}/book/${pro.slug}`);
    check(bPlus.credit > 0 && bPlus.title.includes("Clinicti"), "Clinic+ carries Clinicti's credit and title", JSON.stringify(bPlus));
    check(bPro.credit === 0 && !bPro.title.includes("Clinicti") && bPro.title.includes(pro.name), "Clinic Pro carries neither, and its own name", JSON.stringify(bPro));
    check(bPro.privacy > 0, "…but keeps the privacy notice");

    console.log("Public invoice");
    const iPlus = await visit(`${BASE}/inv/${plus.token}`);
    const iPro = await visit(`${BASE}/inv/${pro.token}`);
    check(iPlus.credit > 0, "Clinic+'s invoice carries the credit");
    check(iPro.credit === 0, "Clinic Pro's does not", JSON.stringify(iPro));

    console.log("Installed app");
    const mPro = await (await fetch(`${BASE}/api/public/manifest/${pro.slug}`)).json();
    check(mPro.name === pro.name && mPro.start_url === `/c/${pro.slug}`, "Clinic Pro's manifest is the clinic's own", JSON.stringify(mPro).slice(0, 160));
    const mPlus = await fetch(`${BASE}/api/public/manifest/${plus.slug}`, { redirect: "manual" });
    check(mPlus.status === 302 && String(mPlus.headers.get("location")).endsWith("/manifest.webmanifest"), "Clinic+ gets Clinicti's");

    console.log("Workspace");
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.fill('input[name="email"]', ownerEmail);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
    await page.goto(`${BASE}/c/${pro.slug}`, { timeout: 180000 });
    await page.waitForSelector("aside", { timeout: 90000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    const title = await page.title();
    check(!title.includes("Clinicti") && title.includes(pro.name), "the Pro workspace's tab names the clinic", title);
    const aside = await page.locator("aside").first().innerText();
    check(!/\bClinicti\b/.test(aside), "its sidebar does not say Clinicti", aside.slice(0, 120));
    await page.goto(`${BASE}/c/${plus.slug}`, { timeout: 180000 });
    await page.waitForSelector("aside", { timeout: 90000 });
    check(/Clinicti/.test(await page.locator("aside").first().innerText()), "the Clinic+ sidebar still does");
  } finally {
    await browser.close();
    await q(`delete from clinics where id = any($1::uuid[])`, [[plus.id, pro.id]]).catch(() => {});
    await q(`delete from users where email = $1`, [ownerEmail]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
