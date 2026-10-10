/**
 * The dentist's notes, made real.
 *
 * Phase 1, here:
 * - who added a patient, by name and job, instead of "الموظفون";
 * - "المستحق" on a part-paid invoice, instead of "متبقٍ";
 * - All-on-4 recorded as a whole arch: implants and bridge teeth drawn on the
 *   teeth, listed once, done or voided as one;
 * - the chart is the file's, not the tab's: an entry survives the tab being
 *   closed and opened again, and a colleague's change arrives without a reload.
 *
 * Fixtures: a dental clinic, its doctor (owner, records on the chart), an
 * English receptionist and an Arabic one, and the patients they work on.
 * Screenshots go to scripts/qa-shots/treatment/.
 *
 * Run against a warm dev server (`npm run qa-warm` first).
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "treatment");

let passed = 0;
let failed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`  ✓ ${m}`);
};
const fail = (m: string) => {
  failed++;
  console.log(`  ✗ ${m}`);
};
const check = (cond: unknown, m: string, detail = "") => (cond ? ok(m) : fail(detail ? `${m} — ${detail}` : m));

async function signIn(browser: Browser, email: string, locale = "en", viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: "cos_locale", value: locale, url: BASE }]);
  const page = await ctx.newPage();
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.waitForLoadState("networkidle");
    if (!new URL(page.url()).pathname.includes("login")) return page;
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
      return page;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log(`  · sign-in for ${email} stalled; trying again`);
    }
  }
}

const chart = (p: Page) => p.locator("[data-dental-chart] svg[role='group']").first();
const panelOf = (p: Page) => p.locator("[data-dental-panel]").first();
async function openFile(page: Page, url: string, waitFor = "[data-dental-chart] [data-tooth='16']") {
  await page.goto(url, { timeout: 120000 });
  await page.waitForSelector(waitFor, { timeout: 120000 });
  await page.waitForTimeout(400);
}
async function tapTooth(page: Page, fdi: string) {
  await chart(page).locator(`[data-tooth='${fdi}']`).first().click();
  await panelOf(page).waitFor({ timeout: 10000 });
}
async function pickIn(scope: ReturnType<Page["locator"]>, key: string, query: string) {
  const search = scope.locator("input[type='search']").first();
  await search.fill(query);
  await scope.locator(`[data-treatment='${key}']`).first().click();
  if (await search.count()) await search.fill("").catch(() => {});
}
const inflight = new WeakMap<Page, number>();
function track(page: Page) {
  inflight.set(page, 0);
  const api = (u: string) => u.includes("/api/");
  page.on("request", (r) => api(r.url()) && inflight.set(page, (inflight.get(page) ?? 0) + 1));
  const done = (r: { url(): string }) => api(r.url()) && inflight.set(page, Math.max(0, (inflight.get(page) ?? 0) - 1));
  page.on("requestfinished", done);
  page.on("requestfailed", done);
}
async function settle(page: Page) {
  const end = Date.now() + 20000;
  for (let quiet = 0; quiet < 3 && Date.now() < end; ) {
    await page.waitForTimeout(120);
    quiet = (inflight.get(page) ?? 0) === 0 ? quiet + 1 : 0;
  }
}
/** Poll until `fn` is true or the time is up; true if it became true. */
async function until(fn: () => Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const looksOf = async (p: Page, fdi: string) => (await chart(p).locator(`[data-tooth='${fdi}']`).first().getAttribute("data-looks")) ?? "";

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  const slug = `qatreat${tag}`;
  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features) values ('QA Treatment','عيادة العلاج',$1,'dental','{dental}','{"dental": true}') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const user = async (email: string, name: string, locale = "en") =>
    (await q(`insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,$4) returning id`, [email, hash, name, locale]))[0].id as string;
  const doctorUser = await user(`treat-doc-${tag}@test.local`, "Lina Mansour");
  const deskUser = await user(`treat-desk-${tag}@test.local`, "Rana Desk");
  const deskArUser = await user(`treat-deskar-${tag}@test.local`, "سلمى", "ar");
  await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1,$2,'doctor',true,'Dr.','{"level":"full"}')`,
    [clinic.id, doctorUser]
  );
  const deskCaps = `{"level":"custom","caps":{"dashboard":true,"patients":true,"calendar":true,"invoices":true,"patients.charts":false}}`;
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',false,$3)`, [clinic.id, deskUser, deskCaps]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',false,$3)`, [clinic.id, deskArUser, deskCaps]);

  const [patient] = await q(
    `insert into patients (clinic_id, full_name, birth_date, phone_e164, source, created_by) values ($1,'Omar Haddad','1979-05-02','+962790001234','staff',$2) returning id`,
    [clinic.id, doctorUser]
  );
  const [waPatient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1,'Wafa From WhatsApp','+962790004321','whatsapp') returning id`, [clinic.id]);
  // A part-paid invoice, for the amount still owed.
  await q(
    `insert into invoices (clinic_id, patient_id, seq, number, status, subtotal, total, amount_paid, issue_date)
     values ($1,$2,1,'INV-0001','partially_paid',50,50,20,current_date)`,
    [clinic.id, patient.id]
  );
  const fileUrl = (id: string, tab = "dental") => `${BASE}/c/${slug}/patients/${id}?tab=${tab}`;

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    /* ── Who added the patient ───────────────────────────────────────── */
    console.log("Who added the patient");
    const desk = await signIn(browser, `treat-desk-${tag}@test.local`);
    desk.on("pageerror", (e) => errors.push(`desk: ${e.message}`));
    track(desk);
    await desk.goto(`${BASE}/c/${slug}/patients`, { timeout: 120000 });
    await desk.getByRole("button", { name: "New patient" }).first().click();
    const dialog = desk.getByRole("dialog");
    await dialog.locator("input").first().fill("Karim Saleh");
    await dialog.getByRole("button", { name: /create|add|save/i }).last().click();
    await desk.waitForURL(/\/patients\/[0-9a-f-]{36}/, { timeout: 60000 });
    await desk.waitForSelector("[data-added-by]", { timeout: 60000 });
    const header = await desk.locator("[data-added-by]").first().innerText();
    check(/Added by Rana Desk · Receptionist/.test(header), "a patient the receptionist types in says who added them, by name and job", header);
    const [karim] = await q(`select created_by from patients where clinic_id = $1 and full_name = 'Karim Saleh'`, [clinic.id]);
    check(karim?.created_by === deskUser, "and the file records that person");

    await desk.goto(`${BASE}/c/${slug}/patients`, { timeout: 120000 });
    await desk.waitForSelector("[data-added-by]", { timeout: 60000 });
    const listText = await desk.locator("main").innerText();
    check(/Rana Desk · Receptionist/.test(listText), "the patient list names who added each patient");
    check(/Dr\. Lina Mansour · Doctor/.test(listText), "a doctor is named with their title and job");
    check(/WhatsApp/.test(listText) && !/\bStaff\b/.test(listText), "a WhatsApp patient still says WhatsApp, and nothing says 'Staff'");

    /* ── المستحق ──────────────────────────────────────────────────────── */
    console.log("المستحق");
    const deskAr = await signIn(browser, `treat-deskar-${tag}@test.local`, "ar");
    deskAr.on("pageerror", (e) => errors.push(`deskAr: ${e.message}`));
    await deskAr.goto(`${BASE}/c/${slug}/invoices`, { timeout: 120000 });
    await deskAr.waitForSelector("text=INV-0001", { timeout: 60000 });
    const invText = await deskAr.locator("main").innerText();
    check(invText.includes("المستحق") && !invText.includes("متبقٍ"), "a part-paid invoice says what is still owed as «المستحق»", invText.slice(0, 200));
    await deskAr.goto(fileUrl(patient.id, "overview"), { timeout: 120000 });
    await deskAr.waitForSelector("[data-added-by]", { timeout: 60000 });
    const arHeader = await deskAr.locator("[data-added-by]").first().innerText();
    check(arHeader.includes("أُضيف بواسطة Dr. Lina Mansour · طبيب"), "in Arabic the file says «أُضيف بواسطة» and the doctor's job", arHeader);
    await deskAr.goto(fileUrl(waPatient.id, "overview"), { timeout: 120000 });
    await deskAr.waitForSelector("[data-added-by]", { timeout: 60000 });
    check((await deskAr.locator("[data-added-by]").first().innerText()).includes("واتساب"), "a patient who came by WhatsApp says واتساب");
    await deskAr.goto(`${BASE}/c/${slug}/patients`, { timeout: 120000 });
    await deskAr.waitForSelector("select", { timeout: 60000 });
    const sources = await deskAr.locator("select option").allInnerTexts();
    check(sources.includes("فريق العيادة") && !sources.includes("الموظفون"), "the source filter offers «فريق العيادة», not «الموظفون»", sources.join(", "));

    /* ── All-on-4 ─────────────────────────────────────────────────────── */
    console.log("All-on-4");
    const doc = await signIn(browser, `treat-doc-${tag}@test.local`);
    doc.on("pageerror", (e) => errors.push(`doctor: ${e.message}`));
    track(doc);
    await openFile(doc, fileUrl(patient.id));
    await tapTooth(doc, "11");
    await pickIn(panelOf(doc), "implant_denture", "all on 4");
    const sheet = doc.locator("[data-full-arch='implant_denture']");
    await sheet.waitFor({ timeout: 10000 });
    const pressed = await sheet.locator("[data-implant-site][aria-pressed='true']").evaluateAll((els) => els.map((e) => e.getAttribute("data-implant-site")).sort());
    check(
      (await sheet.locator("[data-arch='upper'][aria-pressed='true']").count()) === 1 && pressed.join(",") === "12,15,22,25",
      "All-on-4 from tooth 11 opens on the upper arch with implants at 12, 22, 15 and 25",
      pressed.join(",")
    );
    check((await sheet.locator("[data-bridge-teeth]").getAttribute("data-bridge-teeth")) === "16,15,14,13,12,11,21,22,23,24,25,26", "the bridge runs first molar to first molar");
    await sheet.getByRole("radio", { name: "Planned" }).click();
    await doc.screenshot({ path: join(SHOTS, "all-on-4-sheet.png") });
    await sheet.locator("[data-record-full-arch]").click();
    await settle(doc);
    const rows = await q(`select site, treatment_key, role, group_id, status, detail from chart_marks where patient_id = $1 and voided_at is null`, [patient.id]);
    const parent = rows.find((r) => r.site === "upper");
    const implants = rows.filter((r) => r.treatment_key === "implant").map((r) => r.site).sort();
    const bridge = rows.filter((r) => r.role === "pontic").length;
    const extractions = rows.filter((r) => r.treatment_key === "extraction").length;
    check(
      parent?.detail?.implants === "4" && implants.join(",") === "12,15,22,25" && bridge === 12 && extractions === 16 &&
        rows.filter((r) => r.group_id === parent?.group_id).length === 33,
      "it is saved as one group: the arch, four implants, twelve bridge teeth and the sixteen standing teeth to take out",
      JSON.stringify({ implants, bridge, extractions, n: rows.length })
    );
    check((await looksOf(doc, "12")).includes("implant") && (await looksOf(doc, "11")).includes("denture"), "the chart draws an implant on 12 and a bridge tooth on 11");
    const remaining = doc.locator("h3", { hasText: "Remaining work" }).locator("xpath=..");
    const remText = await remaining.innerText();
    check(
      (remText.match(/4 implants at 15 · 12 · 22 · 25, with 16 extractions/g) ?? []).length === 1 && !remText.includes("Simple extraction"),
      "the remaining work lists the full arch once — its implants and its extractions — not sixteen rows",
      remText.slice(0, 300)
    );
    const pillTitle = await chart(doc).locator("[data-region-pill='upper'] title").first().evaluate((el) => el.textContent ?? "");
    check(pillTitle.startsWith("All-on-4"), "the arch's label reads All-on-4", pillTitle);

    // Done, as one.
    await remaining.locator("[data-mark]", { hasText: "4 implants at" }).getByRole("button", { name: "Mark done" }).click();
    await settle(doc);
    const after = await q(`select treatment_key, role, status from chart_marks where patient_id = $1 and group_id = $2`, [patient.id, parent?.group_id]);
    check(after.length === 33 && after.every((r) => r.status === "done"), "marking the full arch done marks its implants, bridge teeth and extractions done", JSON.stringify(after.filter((r) => r.status !== "done")));
    const history = await doc.locator("h3", { hasText: "History" }).locator("xpath=../..").innerText();
    check(!history.includes("Simple extraction"), "the mouth's history lists the full arch, not each of its teeth");
    await openFile(doc, fileUrl(patient.id));
    check((await chart(doc).locator("[data-tooth='12'][data-gone]").count()) === 1 && (await looksOf(doc, "12")).includes("implant"), "after a reload 12 is an implant under the bridge");
    await tapTooth(doc, "12");
    const toothPanel = await panelOf(doc).innerText();
    check(/Part of All-on-4 · Upper arch/.test(toothPanel), "tooth 12 says it is part of the All-on-4", toothPanel.slice(0, 200));
    await panelOf(doc).locator("[data-part-of]").first().getByRole("button", { name: "Open" }).click();
    check(await until(async () => (await doc.getByRole("dialog").innerText()).includes("4 implants at 15 · 12 · 22 · 25, with 16 extractions")), "Open shows the whole arch's entry");
    await doc.keyboard.press("Escape");
    await doc.screenshot({ path: join(SHOTS, "all-on-4-done.png"), fullPage: true });

    /* ── The chart belongs to the file, not the tab ───────────────────── */
    console.log("One chart for the whole file");
    await doc.keyboard.press("Escape");
    await doc.getByRole("radio", { name: "Done" }).first().click().catch(() => {});
    await tapTooth(doc, "36");
    await panelOf(doc).locator("[data-surface-chip='O']").click();
    await pickIn(panelOf(doc), "filling_composite", "composite");
    await settle(doc);
    await doc.getByRole("tab", { name: "Notes" }).click();
    await doc.waitForTimeout(400);
    await doc.getByRole("tab", { name: "Dental chart" }).click();
    await doc.waitForSelector("[data-dental-chart] [data-tooth='36']", { timeout: 30000 });
    check((await looksOf(doc, "36")).includes("filling"), "a filling recorded, then Notes, then back: the filling is still on 36");

    /* ── A colleague's change arrives on its own ──────────────────────── */
    console.log("Live between screens");
    await openFile(desk, fileUrl(patient.id));
    check((await desk.locator("[data-dental-chart]").getAttribute("data-can-write")) === null, "the receptionist reads the chart");
    await tapTooth(doc, "46");
    await pickIn(panelOf(doc), "crown", "crown");
    await settle(doc);
    check(await until(async () => (await looksOf(desk, "46")).includes("crown"), 15000), "the crown the doctor records on 46 appears on the receptionist's screen without a reload");
  } finally {
    if (errors.length) {
      for (const e of errors) fail(`page error: ${e}`);
    }
    await browser.close();
    await db.end();
  }
  console.log(`\nqa-treatment: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
