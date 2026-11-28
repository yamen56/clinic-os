/**
 * Vital signs on the visit record (0125).
 *
 *   - Reading what is typed: a phone's Arabic digits and decimal comma, typos
 *     refused, BMI, the usual adult range.
 *   - The save route merges a reading in, takes a cleared one out, and
 *     refuses one that is not a reading.
 *   - A doctor types them into the record sheet; they save as typed, BMI
 *     appears, a high blood pressure is marked.
 *   - The treatment card shows the latest with the visit before beside it.
 *   - The sheet's vitals fit a phone.
 *
 *   npx tsx scripts/qa-vitals.ts
 */
try { process.loadEnvFile?.(); } catch {}

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { ar } from "../src/lib/i18n/ar";
import { describeSpills, spills } from "./lib-layout";

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

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
}

async function main() {
  const v = await import("../src/lib/treatment/vitals");

  console.log("\n[reading what is typed]");
  check("a decimal comma is a decimal point", v.readVital("temp", "37,5") === 37.5 && v.readVital("temp", "37٫5") === 37.5);
  check("Arabic digits are digits", v.readVital("bp_sys", "١٢٠") === 120);
  check("an impossible reading is refused", v.readVital("spo2", "120") === "bad" && v.readVital("pulse", "7x") === "bad");
  check("an empty field clears", v.readVital("weight", "  ") === null);
  check("a patch is rounded and checked", JSON.stringify(v.cleanVitalsPatch({ temp: 37.25, weight: null })) === '{"temp":37.3,"weight":null}');
  check("an unknown or out-of-range key refuses the patch", v.cleanVitalsPatch({ mood: 5 }) === null && v.cleanVitalsPatch({ bp_sys: 900 }) === null);
  check("BMI from weight and height", v.bmi({ weight: 70, height: 175 }) === 22.9 && v.bmi({ weight: 70 }) === null);
  check("a high blood pressure is marked, a usual pulse is not", v.unusual("bp_sys", 150) && !v.unusual("pulse", 72));

  /* ================================================================ fixture */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `qavit${stamp}`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency)
       values ('QA Vitals','عيادة العلامات',$1,'ar','Asia/Amman','JOD') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  const mkUser = async (tag: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;
  const ownerId = await mkUser("owner", "مالك العيادة");
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'other',true,'{"level":"full"}')`, [clinicId, ownerId]);
  const docUser = await mkUser("doc", "د. سمير حداد");
  const doc = (
    await db.query(`insert into clinic_members (clinic_id, user_id, role, permissions) values ($1,$2,'doctor','{"level":"full"}') returning id`, [clinicId, docUser])
  ).rows[0].id as string;
  const patient = (
    await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1,'خالد منصور','+962790771155','staff') returning id`, [clinicId])
  ).rows[0].id as string;
  // Last month's visit, with a reading to compare against.
  const past = (
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status, arrived_at, finished_at)
       values ($1,$2,$3, now() - interval '30 days', now() - interval '30 days' + interval '30 minutes','completed', now() - interval '30 days', now() - interval '30 days') returning id`,
      [clinicId, patient, doc]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into visit_records (clinic_id, patient_id, appointment_id, doctor_member_id, diagnosis, vitals, created_at)
     values ($1,$2,$3,$4,'ارتفاع ضغط الدم','{"bp_sys":130,"bp_dia":85,"weight":72}', now() - interval '30 days')`,
    [clinicId, patient, past, doc]
  );
  // Today's, in progress.
  const today = (
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status, arrived_at, seated_at)
       values ($1,$2,$3, now() - interval '10 minutes', now() + interval '20 minutes','confirmed', now() - interval '15 minutes', now() - interval '5 minutes') returning id`,
      [clinicId, patient, doc]
    )
  ).rows[0].id as string;

  const browser = await chromium.launch();
  const ctx = async (email: string, viewport = { width: 1360, height: 900 }, touch = false) => {
    const c = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 600 });
    const pg = await c.newPage();
    pg.setDefaultNavigationTimeout(180_000);
    pg.setDefaultTimeout(90_000);
    await signIn(pg, email);
    await c.addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);
    return { c, pg };
  };
  const openFile = async (pg: Page) => {
    await pg.goto(`${BASE}/c/${slug}/patients/${patient}`);
    await pg.waitForLoadState("networkidle");
    await pg.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  };

  try {
    /* ============================================================ the route */
    console.log("\n[the save route]");
    const d = await ctx(`doc-${slug}@test.local`);
    const rid = randomUUID();
    const url = `${BASE}/api/c/${slug}/patients/${patient}/treatment/records/${rid}?visit=${past}`;
    const bad = await d.pg.request.post(url, { data: { patch: { vitals: { spo2: 140 } } } });
    check("a reading that cannot be is refused", bad.status() === 400, String(bad.status()));
    const ok1 = await d.pg.request.post(url, { data: { patch: { vitals: { pulse: 76, sugar: 180 } } } });
    const r1 = (await db.query(`select vitals from visit_records where appointment_id = $1`, [past])).rows[0]?.vitals;
    check("a reading is merged into the visit's record", ok1.status() === 200 && r1?.pulse === 76 && r1?.bp_sys === 130 && r1?.sugar === 180, JSON.stringify(r1));
    await d.pg.request.post(url, { data: { patch: { vitals: { pulse: null, sugar: null } } } });
    const r2 = (await db.query(`select vitals from visit_records where appointment_id = $1`, [past])).rows[0]?.vitals;
    check("a cleared one is taken out", r2 && !("pulse" in r2) && !("sugar" in r2) && r2.weight === 72, JSON.stringify(r2));
    const versions = (await db.query(`select v.vitals from visit_record_versions v join visit_records r on r.id = v.record_id where r.appointment_id = $1`, [past])).rows;
    check("the version history keeps the numbers", versions.length >= 1 && typeof versions[versions.length - 1].vitals === "object");

    /* ============================================================ the sheet */
    console.log("\n[a doctor types them into today's record]");
    await openFile(d.pg);
    await d.pg.locator("[data-treatment-record]").click();
    await d.pg.locator("[data-record-vitals]").waitFor();
    const typed: [string, string][] = [["bp_sys", "150"], ["bp_dia", "95"], ["pulse", "80"], ["temp", "37,2"], ["weight", "70"], ["height", "175"]];
    for (const [k, val] of typed) await d.pg.locator(`[data-vital="${k}"]`).fill(val);
    await d.pg.waitForFunction(
      `(() => { const el = document.querySelector("[data-vitals-bmi]"); return !!el && el.getAttribute("data-vitals-bmi") === "22.9"; })()`
    );
    check("BMI appears from weight and height", true);
    check("the high blood pressure is marked", (await d.pg.locator('[data-vital="bp_sys"][data-vital-unusual]').count()) === 1);
    check("the usual pulse is not", (await d.pg.locator('[data-vital="pulse"][data-vital-unusual]').count()) === 0);
    if (SHOTS) await d.pg.locator("[data-record-sheet]").screenshot({ path: `${SHOTS}/vitals-sheet.png` });
    // Saved as typed: wait for the autosave to land.
    let saved: Record<string, number> | null = null;
    for (let i = 0; i < 30 && !(saved && saved.height === 175); i++) {
      await d.pg.waitForTimeout(500);
      saved = (await db.query(`select vitals from visit_records where appointment_id = $1`, [today])).rows[0]?.vitals ?? null;
    }
    check("they save as typed, onto today's visit", !!saved && saved.bp_sys === 150 && saved.bp_dia === 95 && saved.temp === 37.2 && saved.height === 175, JSON.stringify(saved));

    /* ============================================================ the card */
    console.log("\n[the treatment card]");
    await openFile(d.pg);
    await d.pg.locator("[data-treatment-vitals]").waitFor();
    const card = (await d.pg.locator("[data-treatment-vitals]").innerText()).replace(/\s+/g, " ");
    check("it shows the latest reading", card.includes("150/95") && card.includes("37.2°C"), card);
    check("with the visit before beside it", card.includes("130/85") && card.includes("72 kg"), card);
    check("and BMI", card.includes("22.9"));
    if (SHOTS) await d.pg.locator("[data-treatment-vitals]").screenshot({ path: `${SHOTS}/vitals-card.png` });
    await d.c.close();

    /* ============================================================ phone */
    console.log("\n[on a phone]");
    const ph = await ctx(`doc-${slug}@test.local`, { width: 390, height: 844 }, true);
    await openFile(ph.pg);
    await ph.pg.locator("[data-treatment-record]").click();
    await ph.pg.locator("[data-record-vitals]").waitFor();
    const s = await spills(ph.pg, "[data-record-vitals]");
    check("the vitals fit a phone", s.length === 0, describeSpills(s));
    const h = await ph.pg.locator('[data-vital="pulse"]').boundingBox();
    check("each field is thumb-sized", (h?.height ?? 0) >= 40, `${Math.round(h?.height ?? 0)}px`);
    const mode = await ph.pg.locator('[data-vital="pulse"]').getAttribute("inputmode");
    check("and opens the number pad", mode === "decimal");
    if (SHOTS) await ph.pg.screenshot({ path: `${SHOTS}/vitals-phone.png` });
    await ph.c.close();
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinicId]);
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
