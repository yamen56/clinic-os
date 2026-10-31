/**
 * The platform as one system: what one screen knows, the next one shows.
 *
 * Release 1a, the doctor's quick wins:
 *  - the medical history and its alerts in a clinic without the dental chart,
 *    and the alerts following the patient onto the board, the visit panel and
 *    the prescription;
 *  - a prescription that runs into an allergy waits for "I've checked", and
 *    going on is recorded;
 *  - a doctor's dashboard is their own day, live, with the next step on each
 *    row — and on a phone it comes first;
 *  - one search box on every screen, that finds a patient by an Arabic name
 *    spelled the other way and says when they are next due.
 */
import { Client } from "pg";
import { chromium, devices, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { allergyFor } from "../src/lib/medical-history";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";
const ALL_DAY = JSON.stringify(
  Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["00:00", "23:59"]]]))
);

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function until(fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 60000 });
}

async function main() {
  console.log("\n[the allergy matcher]");
  check("a penicillin allergy catches Augmentin", allergyFor("Penicillin", "Augmentin 1g") === "Penicillin");
  check("and amoxicillin written in Arabic", allergyFor("حساسية من البنسلين", "اموكسيسيلين 500") !== null);
  check("an NSAID allergy catches Brufen", allergyFor("Latex, NSAIDs", "Brufen 400mg") === "NSAIDs");
  check("an allergy written as a drug catches that drug", allergyFor("Tramadol", "Tramadol 50mg") === "Tramadol");
  check("Latex never matches a medicine", allergyFor("Latex", "Paracetamol 500mg") === null);
  check("nothing matches nothing", allergyFor("", "Augmentin") === null && allergyFor("Penicillin", "Paracetamol") === null);

  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qaconn${tag}`;
  const userIds: string[] = [];
  const clinic = (
    await db.query(`insert into clinics (name, slug, timezone, working_hours) values ('QA Connections', $1, $2, $3) returning id`, [slug, TZ, ALL_DAY])
  ).rows[0].id as string;
  const mkUser = async (who: string, name: string) => {
    const id = (
      await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [
        `${who}-${slug}@test.local`,
        bcrypt.hashSync("password123", 10),
        name,
      ])
    ).rows[0].id as string;
    userIds.push(id);
    return id;
  };
  const mkMember = async (userId: string, role: string, perms: unknown, owner = false) =>
    (
      await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, $3, $4, $5) returning id`, [
        clinic,
        userId,
        role,
        owner,
        JSON.stringify(perms),
      ])
    ).rows[0].id as string;
  const custom = (caps: Record<string, boolean>) => ({ level: "custom", caps });

  await mkMember(await mkUser("owner", "QA Owner"), "receptionist", { level: "full" }, true);
  const docA = await mkMember(await mkUser("doca", "Dr Alpha"), "doctor", custom({ dashboard: true, calendar: true, patients: true, "patients.prescriptions": true }));
  const docB = await mkMember(await mkUser("docb", "Dr Beta"), "doctor", custom({ dashboard: true, calendar: true, patients: true }));

  const PHONE = "+962790551177";
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source, medical_history)
       values ($1, 'سارة الخطيب', $2, 'staff', $3) returning id`,
      [clinic, PHONE, JSON.stringify({ conditions: ["anticoagulant", "smoker"], allergies: "Penicillin", medications: "Warfarin", notes: "" })]
    )
  ).rows[0].id as string;
  const other = (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Omar Haddad', '+962790551178', 'staff') returning id`, [clinic])).rows[0]
    .id as string;
  const svc = (await db.query(`insert into services (clinic_id, name, duration_min, price) values ($1, 'Checkup', 30, 20) returning id`, [clinic])).rows[0].id as string;
  const now = DateTime.now();
  const mkAppt = async (p: string, doctor: string, start: DateTime, extra = "") =>
    (
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status${extra ? ", arrived_at" : ""})
         values ($1, $2, $3, $4, $5, $6, 'confirmed'${extra ? ", now() - interval '3 minutes'" : ""}) returning id`,
        [clinic, p, doctor, svc, start.toISO(), start.plus({ minutes: 30 }).toISO()]
      )
    ).rows[0].id as string;
  const waiting = await mkAppt(patient, docA, now.minus({ minutes: 5 }), "arrived");
  await mkAppt(other, docB, now.plus({ minutes: 60 }));
  const tomorrow = now.setZone(TZ).plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  await mkAppt(patient, docA, tomorrow);

  const browser = await chromium.launch();
  const errors: string[] = [];
  const watch = (p: Page) => {
    p.on("pageerror", (e) => errors.push(e.message));
  };
  const hideDevOverlay = (pg: Page) => pg.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  const base = `${BASE}/c/${slug}`;

  try {
    /* ============================================================ the file */
    console.log("\n[the medical history, without the dental chart]");
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(desk);
    await signIn(desk, `owner-${slug}@test.local`);
    await desk.goto(`${base}/patients/${patient}`);
    await desk.waitForSelector("[data-medical-card]", { timeout: 90_000 });
    await hideDevOverlay(desk);
    const header = await desk.locator("main").innerText();
    check("the file's header warns of the allergy", header.includes("Allergy: Penicillin"));
    check("and of the blood thinners", header.includes("Blood thinners"));
    const card = desk.locator("[data-medical-card]");
    check("the Overview shows the history", (await card.innerText()).includes("Warfarin"));

    await desk.click("[data-edit-medical]");
    await desk.fill("[data-allergies]", "Penicillin, Latex");
    await desk.click("[data-save-medical]");
    check("an edit shows on the card", await until(async () => (await card.innerText()).includes("Latex")));
    const saved = (await db.query(`select medical_history from patients where id = $1`, [patient])).rows[0].medical_history;
    check("and is saved with who made it", saved.allergies === "Penicillin, Latex" && saved.updatedBy === "QA Owner", JSON.stringify(saved));

    /* ============================================================ the prescription */
    console.log("\n[a prescription that runs into an allergy]");
    await desk.getByRole("button", { name: "Prescription", exact: true }).click();
    const sheet = desk.getByRole("dialog");
    await sheet.waitFor();
    check("the sheet carries the allergies", (await desk.locator("[data-rx-allergies]").innerText()).includes("Penicillin, Latex"));
    await desk.getByRole("combobox", { name: "Medicine" }).first().fill("Augmentin 1g");
    check("the medicine is flagged", await until(async () => (await desk.locator('[data-rx-allergy="0"]').innerText()).includes("Penicillin")));
    await desk.getByRole("button", { name: "Send on WhatsApp", exact: true }).click();
    await desk.waitForTimeout(1500);
    const before = Number((await db.query(`select count(*) from prescriptions where patient_id = $1`, [patient])).rows[0].count);
    check("it is not saved until somebody has checked", before === 0 && (await sheet.isVisible()));
    await desk.locator("[data-rx-allergy-ack] input").check();
    await desk.getByRole("button", { name: "Send on WhatsApp", exact: true }).click();
    await sheet.waitFor({ state: "detached", timeout: 90_000 });
    const after = Number((await db.query(`select count(*) from prescriptions where patient_id = $1`, [patient])).rows[0].count);
    check("once checked, it is saved", after === 1, String(after));
    const override = (
      await db.query(`select detail from audit_log where clinic_id = $1 and action = 'prescription.allergy_override'`, [clinic])
    ).rows;
    check("and going on is recorded", override.length === 1 && JSON.stringify(override[0].detail).includes("Augmentin"), JSON.stringify(override));

    /* ============================================================ the board */
    console.log("\n[the alerts follow the patient]");
    await desk.goto(`${base}/calendar`);
    await desk.waitForSelector(`[data-flow-card="${waiting}"]`, { timeout: 90_000 });
    check("the board's card warns", (await desk.locator(`[data-flow-card="${waiting}"]`).innerText()).includes("Allergy: Penicillin, Latex"));
    await desk.goto(`${base}/calendar?open=${waiting}`);
    await desk.waitForSelector("[data-panel-medical]", { timeout: 60_000 });
    check("so does the visit's panel", (await desk.locator("[data-panel-medical]").innerText()).includes("Blood thinners"));

    /* ============================================================ search */
    console.log("\n[one search box, everywhere]");
    await desk.goto(`${base}/calendar`);
    await desk.waitForSelector("[data-flow-board]", { timeout: 60_000 });
    await desk.keyboard.press("Control+KeyK");
    await desk.waitForSelector("[data-command-palette]", { timeout: 10_000 });
    check("Ctrl K opens it from the calendar", true);
    await desk.fill("[data-palette-input]", "ساره");
    const hit = desk.locator(`[data-palette-patient="${patient}"]`);
    check("سارة is found by ساره", await until(async () => (await hit.count()) === 1));
    check("with when she is next due", (await hit.innerText()).includes("Next visit"));
    await desk.keyboard.press("Enter");
    await desk.waitForURL(`**/patients/${patient}`, { timeout: 30_000 });
    check("Enter opens her file", desk.url().includes(`/patients/${patient}`));
    await desk.waitForSelector("[data-medical-card]", { timeout: 60_000 });
    await desk.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await desk.keyboard.press("Slash");
    check("/ opens it too", await until(async () => (await desk.locator("[data-command-palette]").count()) === 1, 5000));
    await desk.fill("[data-palette-input]", "zzqqxx");
    check("and says when nobody matches", await until(async () => (await desk.locator("[data-palette-empty]").count()) === 1));
    await desk.keyboard.press("Escape");
    check("Escape closes it", await until(async () => (await desk.locator("[data-command-palette]").count()) === 0, 5000));
    await desk.keyboard.press("KeyA");
    check("A starts a booking from any screen, not only the dashboard", await until(async () => desk.url().includes("/calendar?new=1"), 15_000), desk.url());

    /* ============================================================ the doctor's day */
    console.log("\n[a doctor's dashboard is their own day]");
    const doc = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(doc);
    await signIn(doc, `doca-${slug}@test.local`);
    await doc.goto(base);
    await doc.waitForSelector("[data-today-list]", { timeout: 90_000 });
    check("titled as theirs", (await doc.locator("main").innerText()).includes("My patients today"));
    const rows = await doc.locator("[data-today-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-today-row")));
    check("only their patients", rows.length === 1 && rows[0] === waiting, rows.join(","));
    await doc.click(`[data-today-row="${waiting}"] [data-today-action="seated"]`);
    check(
      "Call in from the dashboard seats the patient",
      await until(async () => !!(await db.query(`select seated_at from appointments where id = $1`, [waiting])).rows[0].seated_at)
    );
    check("and the row moves on to Finish", await until(async () => (await doc.locator(`[data-today-row="${waiting}"] [data-today-action="finished"]`).count()) === 1));
    await doc.click(`[data-today-row="${waiting}"] a`);
    await doc.waitForURL(`**/patients/${patient}`, { timeout: 30_000 });
    check("the row opens the file", doc.url().includes(`/patients/${patient}`));

    await doc.goto(`${base}/calendar`);
    await doc.waitForSelector(`[data-flow-card="${waiting}"] [data-flow-file]`, { timeout: 90_000 });
    await doc.click(`[data-flow-card="${waiting}"] [data-flow-file]`);
    await doc.waitForURL(`**/patients/${patient}`, { timeout: 30_000 });
    check("on the board, a doctor's tap on the patient opens the file", doc.url().includes(`/patients/${patient}`));

    /* ============================================================ the phone */
    console.log("\n[on the doctor's phone]");
    const phoneCtx = await browser.newContext({ ...devices["iPhone 13"] });
    const ph = await phoneCtx.newPage();
    watch(ph);
    await signIn(ph, `doca-${slug}@test.local`);
    await ph.goto(base);
    await ph.waitForSelector("[data-today-list]", { timeout: 90_000 });
    const listTop = (await ph.locator("[data-today-list]").boundingBox())?.y ?? 9999;
    check("their list is on the first screen, above the numbers", listTop < 420, String(listTop));
    const btn = await ph.locator("[data-today-action]").first().boundingBox();
    check("the step is a thumb's height", (btn?.height ?? 0) >= 40, String(btn?.height));
    check("and says what it does", ((await ph.locator("[data-today-action]").first().innerText()) || "").trim() === "Finish");
    const sideways = (await ph.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
    check("nothing scrolls sideways", sideways <= 0, String(sideways));
    await ph.click("header [data-open-search]");
    await ph.waitForSelector("[data-command-palette]", { timeout: 10_000 });
    const pal = await ph.locator("[data-command-palette] [data-palette-input]").boundingBox();
    check("search opens across the whole phone", (pal?.width ?? 0) > 250, String(pal?.width));
    await ph.fill("[data-palette-input]", "0790551177");
    check("and finds her by the number as it is dialled", await until(async () => (await ph.locator(`[data-palette-patient="${patient}"]`).count()) === 1));
    await phoneCtx.close();

    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await browser.close();
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic]);
    await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }

  console.log(`\n  connections: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
