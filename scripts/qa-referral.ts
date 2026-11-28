/**
 * Where a patient came from (0128).
 *
 *   - The new-patient form asks "كيف عرفوا عنا؟" and keeps the answer.
 *   - The file changes it; a friend's name goes in the note, and both save.
 *   - The analytics page counts new patients and what was collected by source,
 *     a cancelled invoice's payment left out, with "not recorded" for the rest.
 *   - A clinic that has never asked is told how to start.
 *
 *   npx tsx scripts/qa-referral.ts
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = process.env.QA_SHOTS_DIR || "";

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

async function main() {
  const { ar } = await import("../src/lib/i18n/ar");
  const R = ar.referral;
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const mkClinic = async (slug: string) =>
    (await db.query(`insert into clinics (name, name_ar, slug, default_locale, timezone, currency) values ('QA Source','عيادة المصادر',$1,'ar','Asia/Amman','JOD') returning id`, [slug])).rows[0].id as string;
  const slug = `qaref${stamp}`;
  const quiet = `qarefq${stamp}`;
  const clinicId = await mkClinic(slug);
  const quietId = await mkClinic(quiet);
  const owner = (
    await db.query(`insert into users (email, password_hash, full_name, locale) values ($1,$2,'مالك','ar') returning id`, [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)])
  ).rows[0].id;
  for (const cid of [clinicId, quietId]) {
    await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'other',true,'{"level":"full"}')`, [cid, owner]);
  }
  // Two patients who paid this month: one from Instagram, one never asked; and a cancelled invoice's payment.
  const mkPatient = async (name: string, phone: string, source: string | null) =>
    (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source, referral_source) values ($1,$2,$3,'staff',$4) returning id`, [clinicId, name, phone, source])).rows[0].id as string;
  const insta = await mkPatient("ريم عواد", "+962790775501", "instagram");
  const unknown = await mkPatient("فادي حنا", "+962790775502", null);
  let seq = 0;
  const pay = async (patientId: string, amount: number, status = "paid") => {
    const inv = (
      await db.query(
        `insert into invoices (clinic_id, patient_id, seq, number, status, total, amount_paid, issue_date) values ($1,$2,$3,$4,$5,$6,$6,current_date) returning id`,
        [clinicId, patientId, ++seq, `QA-${seq}`, status, amount]
      )
    ).rows[0].id;
    await db.query(`insert into payments (clinic_id, invoice_id, patient_id, amount, method) values ($1,$2,$3,$4,'cash')`, [clinicId, inv, patientId, amount]);
  };
  await pay(insta, 120);
  await pay(insta, 999, "void");
  await pay(unknown, 40);

  const browser = await chromium.launch();
  const c = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await c.newPage();
  page.setDefaultNavigationTimeout(180_000);
  page.setDefaultTimeout(90_000);
  const go = async (path: string) => {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  };

  try {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', `owner-${slug}@test.local`);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
    await c.addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);

    console.log("\n[adding a patient]");
    await go(`/c/${slug}/patients`);
    await page.getByRole("button", { name: ar.patients.newPatient }).first().click();
    await page.locator("[data-new-name]").fill("سما الرفاعي");
    await page.locator("[data-new-phone] input, input[data-new-phone]").first().fill("0790775503").catch(() => {});
    await page.locator("select[data-referral-source]").selectOption("tiktok");
    await page.locator("[data-new-create]").click();
    let created: { referral_source: string | null } | undefined;
    for (let i = 0; i < 30 && !created; i++) {
      await page.waitForTimeout(400);
      created = (await db.query(`select referral_source from patients where clinic_id = $1 and full_name = 'سما الرفاعي'`, [clinicId])).rows[0];
    }
    check("the new-patient form keeps where they came from", created?.referral_source === "tiktok", JSON.stringify(created));

    console.log("\n[on the file]");
    await go(`/c/${slug}/patients/${unknown}`);
    await page.locator("select[data-referral-source]").selectOption("friend");
    await page.locator("[data-referral-note]").fill("ريم عواد");
    let saved: { referral_source: string | null; referral_note: string | null } | undefined;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      saved = (await db.query(`select referral_source, referral_note from patients where id = $1`, [unknown])).rows[0];
      if (saved?.referral_note === "ريم عواد") break;
    }
    check("a friend, and who, save from the file", saved?.referral_source === "friend" && saved?.referral_note === "ريم عواد", JSON.stringify(saved));
    // Back to never asked, for the analytics below.
    await db.query(`update patients set referral_source = null, referral_note = null where id = $1`, [unknown]);

    console.log("\n[the analytics page]");
    await go(`/c/${slug}/analytics`);
    const card = page.locator("[data-referral-analytics]");
    await card.waitFor();
    const text = (await card.innerText()).replace(/\s+/g, " ");
    check("Instagram, with what its patients paid — not the cancelled invoice", text.includes(R.sources.instagram) && text.includes("120.00") && !text.includes("999"), text);
    check("and the patients never asked, as not recorded", text.includes(R.notRecorded) && text.includes("40.00"), text);
    check("new patients are counted by source", text.includes(R.sources.tiktok) && text.includes(R.newPatients.replace("{n}", "1")), text);
    if (SHOTS) await page.locator("[data-referral-analytics]").screenshot({ path: `${SHOTS}/referral-analytics.png` });

    await go(`/c/${quiet}/analytics`);
    await page.locator('[data-referral-analytics="empty"]').waitFor();
    check("a clinic that never asked is told how to start", (await page.locator('[data-referral-analytics="empty"]').innerText()).includes("كيف عرفت عنا"));
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = any($1::uuid[])`, [[clinicId, quietId]]);
    await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
