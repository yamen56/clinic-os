/**
 * The dentist's notes, made real — and since 2026-10-12 made simpler: the
 * Treatment tab is gone, and its work is done on the Dental chart tab.
 *
 * - who added a patient, by name and job, instead of "الموظفون";
 * - "المستحق" on a part-paid invoice, instead of "متبقٍ";
 * - All-on-4 recorded as a whole arch: implants and bridge teeth drawn on the
 *   teeth, listed once, done or voided as one;
 * - the chart is the file's, not the tab's: an entry survives the tab being
 *   closed and opened again, and a colleague's change arrives without a reload;
 * - no Treatment tab: the medical history is on the Overview, and a
 *   treatment's steps, emergencies and next visit are on the Dental chart tab;
 * - a treatment's visits are the patient's appointments: what was done at a
 *   visit shows under it, in the Appointments tab and in the calendar;
 * - prices come from the clinic's list (Settings → Treatment prices, by their
 *   English medical names), never typed or shown at the chair;
 * - reception bills what was started or done — from the patient's Invoices
 *   tab, the Invoices page or a new invoice's "From the chart" — the lines
 *   linked to the work, never billed twice, given back by a void;
 * - a price per visit bills its visits; a doctor without invoices cannot ask
 *   for the lines to bill.
 *
 * Fixtures: a dental clinic, its doctor (owner, records on the chart), an
 * English receptionist and an Arabic one, an Arabic manager, and the patients
 * they work on. Screenshots go to scripts/qa-shots/treatment/.
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
  // The live-update stream never finishes; it is not a save to wait for.
  const api = (u: string) => u.includes("/api/") && !u.includes("/events");
  page.on("request", (r) => api(r.url()) && inflight.set(page, (inflight.get(page) ?? 0) + 1));
  const done = (r: { url(): string }) => api(r.url()) && inflight.set(page, Math.max(0, (inflight.get(page) ?? 0) - 1));
  page.on("requestfinished", done);
  page.on("requestfailed", done);
}
async function settle(page: Page) {
  // Long enough for a route compiled on its first request by a cold dev server.
  const end = Date.now() + 60000;
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
const remainingOf = (p: Page) => p.locator("h3", { hasText: "Remaining work" }).locator("xpath=..");
/** A treatment's steps, opened from the chart's remaining work (closing another first). */
async function openCard(p: Page, markId: string) {
  const c = p.locator("[data-procedure]");
  if ((await c.count()) && (await c.getAttribute("data-procedure")) === markId) return;
  if (await c.count()) await c.locator("[data-card-back]").click();
  await remainingOf(p).locator(`[data-mark='${markId}'] [data-open-item]`).first().click();
  await p.locator(`[data-procedure='${markId}']`).waitFor({ timeout: 10000 });
}
/** A day in the clinic's timezone, as a date input takes it. */
const clinicDay = (offsetDays: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86400000));

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  const slug = `qatreat${tag}`;
  // Billing from the chart counts from a week back, so a step dated two days ago is billable.
  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features, dental_billing_since)
     values ('QA Treatment','عيادة العلاج',$1,'dental','{dental}','{"dental": true}', now() - interval '7 days') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const user = async (email: string, name: string, locale = "en") =>
    (await q(`insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,$4) returning id`, [email, hash, name, locale]))[0].id as string;
  const doctorUser = await user(`treat-doc-${tag}@test.local`, "Lina Mansour");
  const deskUser = await user(`treat-desk-${tag}@test.local`, "Rana Desk");
  const deskArUser = await user(`treat-deskar-${tag}@test.local`, "سلمى", "ar");
  const [doctorMember] = await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1,$2,'doctor',true,'Dr.','{"level":"full"}') returning id`,
    [clinic.id, doctorUser]
  );
  const deskCaps = `{"level":"custom","caps":{"dashboard":true,"patients":true,"calendar":true,"invoices":true,"patients.charts":false}}`;
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',false,$3)`, [clinic.id, deskUser, deskCaps]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',false,$3)`, [clinic.id, deskArUser, deskCaps]);

  const [patient] = await q(
    `insert into patients (clinic_id, full_name, birth_date, phone_e164, source, created_by) values ($1,'Omar Haddad','1979-05-02','+962790001234','staff',$2) returning id`,
    [clinic.id, doctorUser]
  );
  const [p2] = await q(`insert into patients (clinic_id, full_name, birth_date, phone_e164, source, created_by) values ($1,'Hala Nasser','1985-11-20','+962790005678','staff',$2) returning id`, [clinic.id, doctorUser]);
  const [waPatient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1,'Wafa From WhatsApp','+962790004321','whatsapp') returning id`, [clinic.id]);
  // A part-paid invoice, for the amount still owed.
  await q(
    `insert into invoices (clinic_id, patient_id, seq, number, status, subtotal, total, amount_paid, issue_date)
     values ($1,$2,1,'INV-0001','partially_paid',50,50,20,current_date)`,
    [clinic.id, patient.id]
  );
  // Numbers come from the clinic's counter: move it past the invoice written by hand.
  await q(`update clinics set invoice_counter = 1 where id = $1`, [clinic.id]);
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

    // Done, as one: a full arch has steps now, so it opens, and "Finish now" closes it with all its parts.
    await remaining.locator("[data-mark]", { hasText: "4 implants at" }).locator("[data-open-item]").click();
    await doc.locator("[data-procedure] [data-finish-now]").click();
    await doc.getByRole("dialog").getByRole("button", { name: "Finish now" }).click();
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

    /* ── No Treatment tab: the medical history is on the Overview ────── */
    console.log("No Treatment tab");
    // Hala is at the clinic today: what is done for her now is filed under this visit.
    const [visitToday] = await q(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
       values ($1,$2,$3, now(), now() + interval '30 minutes', 'confirmed') returning id`,
      [clinic.id, p2.id, doctorMember.id]
    );
    await doc.goto(fileUrl(p2.id, "treatment"), { timeout: 120000 });
    await doc.waitForSelector("[data-medical-card]", { timeout: 120000 });
    const tabs = await doc.locator('[role="tablist"]').first().innerText();
    check(/Overview[\s\S]*Notes/.test(tabs) && !/Treatment/.test(tabs), "there is no Treatment tab: Overview, then Notes", tabs.replace(/\s+/g, " "));
    check((await doc.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")) === "true", "an old link to the Treatment tab opens the Overview");

    // Medical history: once for the patient, on the Overview, an alert in the header.
    await doc.locator("[data-edit-medical]").click();
    await doc.locator("[data-condition='anticoagulant']").click();
    await doc.locator("[data-allergies]").fill("Penicillin");
    await doc.locator("[data-save-medical]").click();
    const medical = async () => (await q(`select medical_history from patients where id = $1`, [p2.id]))[0].medical_history;
    check(
      await until(async () => {
        const mh = await medical();
        return !!mh?.conditions?.includes("anticoagulant") && mh.allergies === "Penicillin" && mh.updatedBy === "Lina Mansour";
      }, 15000),
      "the medical history is edited on the Overview and kept on the patient, with who changed it",
      JSON.stringify(await medical())
    );
    check(await until(async () => (await doc.locator("[data-medical-card]").innerText()).includes("Penicillin")), "the Overview's medical card shows it");
    const alertsText = await doc.locator("main").innerText();
    check(alertsText.includes("Allergy: Penicillin") && alertsText.includes("Blood thinners"), "the file's header warns of the allergy and the blood thinners");
    await doc.screenshot({ path: join(SHOTS, "overview-medical.png"), fullPage: true });

    /* ── A treatment's steps, on the Dental chart tab ────────────────── */
    console.log("Steps on the Dental chart tab");
    await doc.getByRole("tab", { name: "Dental chart" }).click();
    await doc.waitForSelector("[data-dental-chart] [data-tooth='36']", { timeout: 60000 });
    // A root canal: tapped as done, it starts, and its steps open in front of the doctor.
    await tapTooth(doc, "36");
    await panelOf(doc).getByRole("radio", { name: "Done" }).click();
    await pickIn(panelOf(doc), "rct", "root canal");
    const card = doc.locator("[data-procedure]");
    await card.waitFor({ timeout: 10000 });
    await settle(doc);
    check(
      (await card.getAttribute("data-procedure-status")) === "planned" && (await card.locator("[data-step='access']").getAttribute("data-step-state")) === "next",
      "a root canal tapped as done starts today: its steps open, access cavity next"
    );
    const [rct] = await q(`select id, status from chart_marks where patient_id = $1 and treatment_key = 'rct'`, [p2.id]);
    check(rct?.status === "planned", "it is saved as under way");
    await card.locator("[data-step-done='access']").click();
    await settle(doc);
    // Three canals, measured.
    await card.getByRole("button", { name: "3 canals" }).click();
    await settle(doc);
    const lengthForm = card.locator("[data-step-form='length']");
    await lengthForm.waitFor({ timeout: 10000 });
    const names = await lengthForm.locator("[data-canal]").evaluateAll((els) => els.map((e) => e.getAttribute("data-canal")));
    check(names.join(",") === "MB,ML,D", "a lower molar with three canals offers MB, ML and D", names.join(","));
    await lengthForm.getByLabel("MB Length mm").fill("21");
    await lengthForm.getByLabel("ML Length mm").fill("20.5");
    await lengthForm.getByLabel("D Length mm").fill("22");
    await lengthForm.locator("[data-choice='method:apex']").click();
    await card.locator("[data-step-done='length']").click();
    await settle(doc);
    const lengthRows = await q(`select data from chart_mark_steps where mark_id = $1 and step = 'length' and voided_at is null`, [rct.id]);
    check(
      JSON.stringify(lengthRows[0]?.data?.canals?.map((c: { name: string; length: number }) => [c.name, c.length])) === JSON.stringify([["MB", 21], ["ML", 20.5], ["D", 22]]) && lengthRows[0]?.data?.method === "apex",
      "the working length of each canal is saved with the step",
      JSON.stringify(lengthRows[0]?.data)
    );
    check((await card.locator("[data-step='length'] [data-step-summary]").innerText()).includes("MB 21 · ML 20.5 · D 22 mm"), "and reads back as MB 21 · ML 20.5 · D 22 mm");
    check((await card.locator("[data-progress]").getAttribute("data-progress")) === "2/5", "two of its five required steps are done");
    const filed = await q(`select step, appointment_id from chart_mark_steps where mark_id = $1 and voided_at is null`, [rct.id]);
    check(filed.length === 2 && filed.every((s) => s.appointment_id === visitToday.id), "each step is filed under today's visit", JSON.stringify(filed));
    await card.locator("[data-card-back]").click();
    check(
      await until(async () => (await remainingOf(doc).locator(`[data-mark='${rct.id}'] [data-entry-progress]`).first().getAttribute("data-entry-progress")) === "2/5"),
      "the chart's remaining work shows the root canal, two steps in"
    );

    /* ── A treatment's visits are the patient's appointments ─────────── */
    console.log("Visits are appointments");
    await doc.getByRole("tab", { name: "Appointments" }).click();
    const todayRow = doc.locator(`[data-appointment-row='${visitToday.id}']`);
    await todayRow.waitFor({ timeout: 30000 });
    check(
      (await todayRow.locator("[data-visit-work-count]").getAttribute("data-visit-work-count")) === "1",
      "today's visit, in the Appointments tab, holds the one treatment worked on at it"
    );
    await todayRow.locator("button").first().click();
    const doneText = await todayRow.locator("[data-visit-done]").innerText();
    check(
      (await todayRow.locator("[data-visit-done]").getAttribute("data-visit-done")) === "1" && doneText.includes("Root canal treatment") && doneText.includes("Access cavity, Working length"),
      "opened, it is one line: the root canal, then its access cavity and working length",
      doneText
    );
    await doc.screenshot({ path: join(SHOTS, "appointments-visit-work.png"), fullPage: true });
    await todayRow.locator(`[data-visit-work-item='${rct.id}']`).first().click();
    check(await until(async () => (await card.getAttribute("data-procedure")) === rct.id), "a line opens the root canal on the Dental chart tab");

    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 7 * 86400000).toISOString();
    type ApiAppt = { id: string; items: { markId: string }[]; done?: { markId: string; site: string; label: string; steps: string[] }[] };
    const calendarAppts = async () =>
      ((await (await doc.request.get(`${BASE}/api/c/${slug}/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json()) as { appointments: ApiAppt[] })
        .appointments;
    const todayApi = (await calendarAppts()).find((a) => a.id === visitToday.id);
    check(
      todayApi?.done?.length === 1 && todayApi.done[0].markId === rct.id && todayApi.done[0].steps.join(",") === "access,length",
      "the calendar's visit carries what was done at it, one line per treatment",
      JSON.stringify(todayApi?.done)
    );
    await doc.goto(`${BASE}/c/${slug}/calendar?open=${visitToday.id}`, { timeout: 120000 });
    await doc.waitForSelector("[data-done-at-visit]", { timeout: 60000 });
    check(
      (await doc.locator("[data-done-at-visit]").getAttribute("data-done-at-visit")) === "1" && (await doc.locator("[data-done-at-visit]").innerText()).includes("Access cavity, Working length"),
      "and its panel in the calendar says so, under Done at this visit"
    );
    await doc.screenshot({ path: join(SHOTS, "calendar-done-at-visit.png") });

    // Book the next visit from the treatment: the visit knows what it is for.
    await openFile(doc, fileUrl(p2.id));
    await openCard(doc, rct.id);
    await card.locator("[data-book-next]").click();
    await doc.waitForURL(/\/calendar\?/, { timeout: 60000 });
    await doc.waitForSelector("[data-planned-treatment]", { timeout: 60000 });
    const planned = await doc.locator("[data-planned-treatment]").innerText();
    check(planned.includes("Root canal treatment") && planned.includes("Cleaning & shaping"), "Book next visit opens the calendar with the treatment and its next step", planned);
    const tomorrow = clinicDay(1);
    await doc.locator("aside input[type='date']").fill(tomorrow);
    await doc.getByRole("button", { name: "Save" }).last().click();
    check(await until(async () => (await q(`select ai.appointment_id from appointment_items ai where ai.mark_id = $1`, [rct.id])).length === 1, 20000), "the appointment is booked with the treatment it is for");
    const [appt] = await q(
      `select a.id, a.status, a.doctor_member_id, (a.starts_at at time zone 'Asia/Amman')::date::text as day
         from appointments a join appointment_items ai on ai.appointment_id = a.id where ai.mark_id = $1`,
      [rct.id]
    );
    check(appt?.doctor_member_id === doctorMember.id && appt.day === tomorrow, "tomorrow, with the doctor doing it", JSON.stringify(appt));
    check((await calendarAppts()).find((a) => a.id === appt.id)?.items?.[0]?.markId === rct.id, "the calendar's appointment carries the treatment it is for");

    await openFile(doc, fileUrl(p2.id));
    await openCard(doc, rct.id);
    check((await card.locator("[data-next-visit]").getAttribute("data-next-visit")) === appt.id, "the root canal's card shows its next visit");
    await doc.getByRole("tab", { name: "Appointments" }).click();
    const bookedRow = doc.locator(`[data-appointment-row='${appt.id}']`);
    await bookedRow.locator("button").first().click();
    check(
      await until(async () => (await bookedRow.locator("[data-visit-planned]").getAttribute("data-visit-planned")) === "1"),
      "and the visit booked for it, in the Appointments tab, lists it as planned"
    );

    // An emergency in the middle: recorded, and the booked visit stays.
    await doc.getByRole("tab", { name: "Dental chart" }).click();
    await doc.waitForSelector("[data-dental-chart] [data-tooth='36']", { timeout: 30000 });
    await openCard(doc, rct.id);
    await card.locator("[data-emergency-item]").click();
    const esheet = doc.locator("[data-emergency-sheet]");
    await esheet.waitFor({ timeout: 10000 });
    check((await esheet.locator("[data-emergency-next]").getAttribute("data-emergency-next")) === appt.id, "the emergency sheet says the planned visit stays");
    await esheet.locator("[data-emergency-complaint]").fill("Swelling overnight");
    await esheet.locator("[data-emergency-action='dressing']").click();
    await esheet.locator("[data-record-emergency]").click();
    await settle(doc);
    const em = await q(`select data, appointment_id from chart_mark_steps where mark_id = $1 and step = 'emergency'`, [rct.id]);
    const [stillBooked] = await q(`select status from appointments where id = $1`, [appt.id]);
    check(em.length === 1 && em[0].data.complaint === "Swelling overnight" && em[0].data.done.includes("dressing"), "the emergency is recorded on the root canal, with what was done");
    check(em[0]?.appointment_id === visitToday.id, "at today's visit");
    check(stillBooked.status === "scheduled", "and the planned visit is not cancelled");

    // Two visits: the access was done on an earlier day.
    await q(`update chart_mark_steps set done_at = now() - interval '2 days', appointment_id = null where mark_id = $1 and step = 'access'`, [rct.id]);
    await openFile(doc, fileUrl(p2.id));
    await openCard(doc, rct.id);
    check((await card.locator("[data-sessions]").getAttribute("data-sessions")) === "2", "steps done on two days count as two visits");

    // The rest of it: shaping, irrigation, obturation — then it is finished, and a crown is offered.
    await card.locator("[data-step-form='shaping']").waitFor({ timeout: 10000 });
    await card.locator("[data-step-form='shaping']").getByLabel("MB Master file").fill("25/.06");
    await card.locator("[data-step-done='shaping']").click();
    await settle(doc);
    await card.locator("[data-step-form='irrigation'] [data-choice='irrigants:naocl25']").click();
    await card.locator("[data-step-form='irrigation'] [data-choice='irrigants:edta']").click();
    await card.locator("[data-step-done='irrigation']").click();
    await settle(doc);
    // After irrigation the next step in order is the optional medicament; the obturation is opened by hand.
    if (!(await card.locator("[data-step-form='obturation']").count())) await card.locator("[data-step='obturation'] button").first().click();
    await card.locator("[data-step-form='obturation'] [data-choice='technique:warm']").click();
    await card.locator("[data-step-done='obturation']").click();
    await settle(doc);
    const [finished] = await q(`select status, done_at from chart_marks where id = $1`, [rct.id]);
    check(finished.status === "done" && !!finished.done_at, "the last required step finishes the root canal");
    check((await card.getAttribute("data-procedure-status")) === "done" && (await card.locator("[data-follow-up='crown']").count()) === 1, "and a crown is offered as what comes next");
    await card.locator("[data-follow-up='crown']").click();
    await settle(doc);
    const crown36 = await q(`select id, status from chart_marks where patient_id = $1 and site = '36' and treatment_key = 'crown'`, [p2.id]);
    check(crown36.length === 1 && crown36[0].status === "planned", "planning it puts a crown on 36");
    // Finished, the root canal is no longer what the booked visit is for.
    check(
      ((await calendarAppts()).find((a) => a.id === appt.id)?.items ?? []).length === 0,
      "finished, the root canal leaves the booked visit's planned treatment"
    );

    // An optional step recorded by mistake is taken back.
    await card.locator("[data-step='restoration'] button").first().click();
    await card.locator("[data-step-done='restoration']").click();
    await settle(doc);
    await card.locator("[data-step-undo='restoration']").click();
    await settle(doc);
    const restoration = await q(`select 1 from chart_mark_steps where mark_id = $1 and step = 'restoration'`, [rct.id]);
    check(restoration.length === 0, "a step taken back within two minutes is gone");
    await doc.screenshot({ path: join(SHOTS, "dental-chart-steps.png"), fullPage: true });

    // A full arch on its steps: placing the implants does the implants and the extractions; delivering the bridge, the bridge.
    if (await card.count()) await card.locator("[data-card-back]").click();
    await tapTooth(doc, "41");
    await pickIn(panelOf(doc), "implant_denture", "all on 4");
    const arch = doc.locator("[data-full-arch='implant_denture']");
    await arch.waitFor({ timeout: 10000 });
    await arch.getByRole("radio", { name: "Planned" }).click();
    await arch.locator("[data-record-full-arch]").click();
    await settle(doc);
    const [lower] = await q(`select id, group_id from chart_marks where patient_id = $1 and site = 'lower' and treatment_key = 'implant_denture'`, [p2.id]);
    await card.waitFor({ timeout: 10000 });
    check((await card.getAttribute("data-procedure")) === lower.id, "a full arch opens its steps at once");
    if (!(await card.locator("[data-step-form='placement']").count())) await card.locator("[data-step='placement'] button").first().click();
    const implantRows = await card.locator("[data-step-form='placement'] [data-implant-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-implant-row")));
    check([...implantRows].sort().join(",") === "32,35,42,45", "placing the implants asks about each of the four", implantRows.join(","));
    await card.locator("[data-step-form='placement'] [data-implant-row='42']").getByLabel("Ncm").fill("45");
    await card.locator("[data-step-done='placement']").click();
    await settle(doc);
    const parts = await q(`select look, role, status from chart_marks where group_id = $1 and id <> $2`, [lower.group_id, lower.id]);
    check(
      parts.filter((x) => x.look === "implant").every((x) => x.status === "done") &&
        parts.filter((x) => x.look === "extraction").every((x) => x.status === "done") &&
        parts.filter((x) => x.role === "pontic").every((x) => x.status === "planned"),
      "placing them marks the implants and extractions done, the bridge still to come"
    );
    if (!(await card.locator("[data-step-form='impression']").count())) await card.locator("[data-step='impression'] button").first().click();
    await card.locator("[data-step-done='impression']").click();
    await settle(doc);
    if (!(await card.locator("[data-step-form='delivery']").count())) await card.locator("[data-step='delivery'] button").first().click();
    await card.locator("[data-step-form='delivery'] [data-choice='material:zirconia']").click();
    await card.locator("[data-step-done='delivery']").click();
    await settle(doc);
    const all = await q(`select status from chart_marks where group_id = $1`, [lower.group_id]);
    check(all.every((x) => x.status === "done"), "delivering the bridge finishes the full arch and every part of it");
    // At the visit it is one line — the arch, with its steps — not a line for each of its 32 parts.
    const visitDone = (await calendarAppts()).find((a) => a.id === visitToday.id)?.done ?? [];
    const archLines = visitDone.filter((d) => d.markId === lower.id);
    check(
      archLines.length === 1 && archLines[0].site === "lower" && archLines[0].steps.includes("placement") && archLines[0].steps.includes("delivery") &&
        !visitDone.some((d) => d.label === "Simple extraction" || d.label === "Implant placement") && visitDone.length === 2,
      "the visit lists the full arch once, with its steps, beside the root canal",
      JSON.stringify(visitDone.map((d) => [d.site, d.label, d.steps.join("+")]))
    );

    // The receptionist reads the medical history and the treatment, with nothing to record.
    await desk.goto(fileUrl(p2.id, "overview"), { timeout: 120000 });
    await desk.waitForSelector("[data-medical-card]", { timeout: 60000 });
    check((await desk.locator("[data-medical-card]").innerText()).includes("Penicillin"), "the receptionist sees the medical history on the Overview");
    await desk.getByRole("tab", { name: "Dental chart" }).click();
    await desk.waitForSelector("[data-dental-chart] [data-tooth='36']", { timeout: 60000 });
    await openCard(desk, crown36[0].id);
    check(
      (await desk.locator("[data-procedure] [data-step-done], [data-procedure] [data-emergency-item], [data-procedure] [data-finish-now]").count()) === 0,
      "and reads a treatment's steps, with nothing to record"
    );

    /* ── Phase 3: the clinic's prices ─────────────────────────────────── */
    console.log("Prices");
    const servicePrice = async (key: string, variant: string | null) =>
      (
        await q(
          `select id, price::float as price, price_unit, bookable_online, name, name_ar from services
            where clinic_id = $1 and chart_key = $2 and coalesce(chart_variant, '') = coalesce($3, '') and active`,
          [clinic.id, key, variant]
        )
      )[0];
    await doc.goto(`${BASE}/c/${slug}/settings/services`, { timeout: 120000 });
    await doc.waitForSelector("[data-prices-link]", { timeout: 120000 });
    check(true, "Services points to the treatment prices");
    await doc.goto(`${BASE}/c/${slug}/settings/prices`, { timeout: 120000 });
    await doc.waitForSelector("[data-dental-prices]", { timeout: 120000 });
    check((await doc.locator("nav a", { hasText: "Treatment prices" }).count()) > 0, "Treatment prices has its own place in Settings");
    check(
      (await doc.locator("[data-needs-row='crown:zirconia']").count()) === 1 && (await doc.locator("[data-needs-row='rct:3']").count()) === 1,
      "the price page opens on what was charted with no price: the zirconia crowns and the three-canal root canal"
    );
    // A price box saves when it is left: Enter leaves it.
    const priceIn = async (box: string, value: string, key: string, variant: string | null) => {
      const input = doc.locator(box).first();
      await input.fill(value);
      await input.press("Enter");
      return until(async () => (await servicePrice(key, variant))?.price === Number(value), 20000);
    };
    check(await priceIn("[data-price-row='crown'] [data-price-box='Crown']", "100", "crown", null), "a crown is priced at 100");
    check(
      await until(async () => (await q(`select count(*)::int as n from chart_marks where clinic_id = $1 and treatment_key = 'crown' and fee = 100 and voided_at is null`, [clinic.id]))[0].n === 2),
      "the two crowns already charted with no price take it"
    );
    check(await until(async () => (await doc.locator("[data-needs-row='crown:zirconia']").count()) === 0), "and they leave Needs a price");
    check(await priceIn("[data-price-variant='crown:zirconia'] [data-price-box]", "120", "crown", "zirconia"), "a zirconia crown at 120");
    check(await priceIn("[data-price-variant='crown:emax'] [data-price-box]", "110", "crown", "emax"), "an E-max crown at 110");
    check(await priceIn("[data-price-variant='rct:3'] [data-price-box]", "90", "rct", "3"), "a root canal with three canals at 90");
    check(await until(async () => (await q(`select fee::float as fee from chart_marks where id = $1`, [rct.id]))[0].fee === 90), "the root canal finished before there was a price takes it too");
    check(await priceIn("[data-price-row='scaling'] [data-price-box='Scaling & polishing']", "30", "scaling", null), "and a cleaning at 30");
    await doc.locator("[data-price-unit='scaling']:not([disabled])").selectOption("session");
    check(await until(async () => (await servicePrice("scaling", null))?.price_unit === "session", 20000), "the cleaning charged per visit");
    const zirconia = await servicePrice("crown", "zirconia");
    check(
      zirconia?.bookable_online === false && zirconia.name === "Crown (Zirconia)" && zirconia.name_ar === "تاج (تلبيسة) · زركون",
      "each price is one of the clinic's services, named in both languages, not offered for booking",
      JSON.stringify(zirconia)
    );
    check(((await doc.locator("[data-invoice-preview='crown']").innerText()) ?? "").includes("Crown — tooth 36"), "and each row says what the patient will read on the invoice");

    // The list speaks the doctor's language: English medical names, on an Arabic page too.
    const mgrUser = await user(`treat-mgr-${tag}@test.local`, "مها", "ar");
    await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',false,'{"level":"full"}')`, [clinic.id, mgrUser]);
    const mgr = await signIn(browser, `treat-mgr-${tag}@test.local`, "ar");
    mgr.on("pageerror", (e) => errors.push(`manager: ${e.message}`));
    await mgr.goto(`${BASE}/c/${slug}/settings/prices`, { timeout: 120000 });
    await mgr.waitForSelector("[data-dental-prices]", { timeout: 120000 });
    const rctRow = mgr.locator("[data-price-row='rct']");
    check(
      (await mgr.locator("html").getAttribute("dir")) === "rtl" && (await rctRow.locator("[data-price-name]").innerText()).trim() === "Root canal treatment",
      "on an Arabic page a treatment keeps its English medical name",
      await rctRow.locator("[data-price-name]").innerText()
    );
    check((await rctRow.innerText()).includes("RCT · علاج عصب"), "its abbreviation and Arabic name follow it, smaller", await rctRow.innerText());
    check((await mgr.locator("[data-price-variant='crown:zirconia']").innerText()).includes("Zirconia"), "and the kinds of a treatment are named in English too");
    await mgr.screenshot({ path: join(SHOTS, "prices-arabic.png"), fullPage: true });
    await mgr.context().close();

    /* ── Prices come from the list, never from the chair ─────────────── */
    console.log("Prices come from the list");
    const [p3] = await q(
      `insert into patients (clinic_id, full_name, birth_date, phone_e164, source, created_by) values ($1,'Sami Khoury','1990-03-14','+962790009999','staff',$2) returning id`,
      [clinic.id, doctorUser]
    );
    await openFile(doc, fileUrl(p3.id));
    const planOn = async (fdi: string, key: string, query: string) => {
      if (await card.count()) await card.locator("[data-card-back]").click();
      await tapTooth(doc, fdi);
      await panelOf(doc).getByRole("radio", { name: "Planned" }).click();
      await pickIn(panelOf(doc), key, query);
      await card.waitFor({ timeout: 10000 });
      await settle(doc);
    };
    const markOf = async (site: string, key: string) =>
      (
        await q(
          `select id, fee::float as fee, fee_manual, service_id, detail from chart_marks
            where patient_id = $1 and site = $2 and treatment_key = $3 and voided_at is null`,
          [p3.id, site, key]
        )
      )[0];
    /** Nothing about money on the chart: no price to type, to read or to bill. */
    const noPrices = async (p: Page) =>
      (await p.locator("[data-fee], [data-use-for-all], [data-plan-total], [data-plan-price], [data-plan-noprice], [data-set-prices], [data-billed], [data-price-row-card], [data-bill]").count()) === 0;
    await planOn("16", "crown", "crown");
    const crown16 = await markOf("16", "crown");
    check(
      crown16?.fee === 120 && crown16.detail?.material === "zirconia" && crown16.service_id === (await servicePrice("crown", "zirconia"))?.id,
      "a crown planned on 16 — zirconia until another material is chosen — takes the list's zirconia price",
      JSON.stringify(crown16)
    );
    check((await noPrices(doc)) && !/\b120\b/.test(await card.innerText()), "the doctor is shown no price and asked for none");
    await card.getByRole("button", { name: "Porcelain-fused-to-metal (PFM)" }).first().click();
    check(await until(async () => (await markOf("16", "crown"))?.fee === 100), "porcelain-fused-to-metal, with no price of its own, costs what a crown does: 100");
    await card.getByRole("button", { name: "E-max" }).first().click();
    check(
      await until(async () => {
        const r = await markOf("16", "crown");
        return r?.detail?.material === "emax" && r.fee === 110;
      }),
      "E-max takes the list's E-max price, 110"
    );
    await planOn("26", "rct", "root canal");
    await card.getByRole("button", { name: "3 canals" }).click();
    check(await until(async () => (await markOf("26", "rct"))?.fee === 90), "a root canal on 26 with three canals is priced 90");
    const rct26 = await markOf("26", "rct");
    const billableLines = async () =>
      ((await (await desk.request.get(`${BASE}/api/c/${slug}/patients/${p3.id}/dental/billable`)).json()) as { lines: { markId: string; qty: number; unitPrice: number }[] }).lines;
    check((await billableLines()).length === 0, "nothing is ready to bill before it is started");

    // Started — the crown prepared, the canals opened: now reception can bill them.
    await openCard(doc, crown16.id);
    await card.locator("[data-step-done='prep']").click();
    await settle(doc);
    await openCard(doc, rct26.id);
    await card.locator("[data-step-done='access']").click();
    await settle(doc);
    check(await until(async () => (await billableLines()).length === 2), "once started, both are ready to bill");
    check(await noPrices(doc), "and still nothing about money on the doctor's chart");
    await doc.screenshot({ path: join(SHOTS, "chart-without-prices.png"), fullPage: true });

    // The names on the invoice are the clinic's: reception renames the E-max crown the way patients say it.
    await doc.goto(`${BASE}/c/${slug}/settings/prices`, { timeout: 120000 });
    await doc.waitForSelector("[data-rename-price='crown']", { timeout: 60000 });
    await doc.locator("[data-rename-price='crown']").click();
    const renameDialog = doc.locator("[data-rename-dialog]");
    await renameDialog.waitFor({ timeout: 10000 });
    await renameDialog.locator("div.grid", { hasText: "Crown · E-max" }).last().getByLabel("Arabic").fill("تلبيسة إي ماكس");
    await renameDialog.locator("[data-save-names]").click();
    check(await until(async () => (await servicePrice("crown", "emax"))?.name_ar === "تلبيسة إي ماكس"), "the E-max crown's Arabic name on the invoice is renamed");

    /* ── A doctor who does not bill ───────────────────────────────────── */
    console.log("A doctor without invoices");
    const doc2User = await user(`treat-doc2-${tag}@test.local`, "Yousef Haddad");
    await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1,$2,'doctor',false,'Dr.',$3)`, [
      clinic.id,
      doc2User,
      `{"level":"custom","caps":{"dashboard":true,"patients":true,"patients.charts":true,"calendar":true,"invoices":false}}`,
    ]);
    const doc2 = await signIn(browser, `treat-doc2-${tag}@test.local`);
    doc2.on("pageerror", (e) => errors.push(`doctor2: ${e.message}`));
    track(doc2);
    await openFile(doc2, fileUrl(p3.id));
    await openCard(doc2, crown16.id);
    check(
      (await noPrices(doc2)) && !/\b110\b/.test(await doc2.locator("[data-procedure]").innerText()),
      "a doctor without invoices sees no price and nothing billed on the chart either"
    );
    check((await doc2.request.get(`${BASE}/api/c/${slug}/patients/${p3.id}/dental/billable`)).status() === 403, "and cannot ask for the lines to bill");
    await doc2.context().close();

    /* ── Ready to bill ────────────────────────────────────────────────── */
    console.log("Ready to bill");
    await desk.goto(fileUrl(p3.id, "invoices"), { timeout: 120000 });
    await desk.waitForSelector("[data-ready-to-bill]", { timeout: 60000 });
    const ready = desk.locator("[data-ready-to-bill]");
    check(
      (await ready.getAttribute("data-ready-to-bill")) === "2" && (await ready.getAttribute("data-ready-total")) === "200",
      "the patient's Invoices tab has the two treatments ready to bill, 200 in all"
    );
    const readyText = await ready.innerText();
    check(readyText.includes("Crown (E-max) — tooth 16") && readyText.includes("Root canal treatment (3 canals) — tooth 26"), "each worded as its invoice line will be", readyText);
    await deskAr.goto(fileUrl(p3.id, "invoices"), { timeout: 120000 });
    await deskAr.waitForSelector("[data-ready-to-bill]", { timeout: 60000 });
    const readyAr = await deskAr.locator("[data-ready-to-bill]").innerText();
    check(readyAr.includes("جاهز للفوترة") && readyAr.includes("تلبيسة إي ماكس — سن 16"), "and in Arabic, in the clinic's own words for it", readyAr);

    await desk.goto(`${BASE}/c/${slug}/invoices`, { timeout: 120000 });
    await desk.waitForSelector(`[data-desk-patient='${p3.id}']`, { timeout: 60000 });
    const deskRow = await desk.locator(`[data-desk-patient='${p3.id}']`).innerText();
    check(deskRow.includes("Sami Khoury") && deskRow.includes("2 treatments") && deskRow.includes("200"), "the Invoices page lists the patient for the desk: two treatments, 200", deskRow);
    await desk.screenshot({ path: join(SHOTS, "ready-to-bill-desk.png"), fullPage: true });

    /* ── Billing ──────────────────────────────────────────────────────── */
    console.log("Billing");
    const lineValues = (p: Page) => p.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    await desk.locator(`[data-desk-bill='${p3.id}']`).click();
    await desk.waitForURL(/\/invoices\/new\?/, { timeout: 60000 });
    check(await until(async () => (await lineValues(desk)).includes("Crown (E-max) — tooth 16"), 60000), "Bill opens a new invoice with the crown's line written");
    check((await lineValues(desk)).includes("Root canal treatment (3 canals) — tooth 26"), "and the root canal's");
    const billUrl = desk.url();
    // Two desks bill the same work at once: the second is told it is billed already.
    await deskAr.goto(billUrl, { timeout: 120000 });
    check(await until(async () => (await lineValues(deskAr)).includes("تلبيسة إي ماكس — سن 16"), 60000), "the same Bill at a second desk, in Arabic, writes its lines in Arabic");
    // A note on the invoice: it shows in the patient's notes too.
    await desk.getByPlaceholder("Shown at the bottom of the invoice…").fill("Half paid in cash, the rest at the next visit");
    await desk.getByRole("button", { name: "Create", exact: true }).click();
    await desk.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60000 });
    const invoiceId = new URL(desk.url()).pathname.split("/").pop()!;
    const billedLines = await q(
      `select ii.qty::float as qty, ii.unit_price::float as price, iim.mark_id
         from invoice_items ii left join invoice_item_marks iim on iim.invoice_item_id = ii.id
        where ii.invoice_id = $1 order by ii.sort`,
      [invoiceId]
    );
    check(
      billedLines.length === 2 &&
        billedLines.some((l) => l.mark_id === crown16.id && l.price === 110 && l.qty === 1) &&
        billedLines.some((l) => l.mark_id === rct26.id && l.price === 90 && l.qty === 1),
      "creating it bills the crown at 110 and the root canal at 90, each line linked to its treatment",
      JSON.stringify(billedLines)
    );
    await deskAr.getByRole("button", { name: "إنشاء", exact: true }).click();
    check(await until(async () => (await deskAr.locator("body").innerText()).includes("بعض هذه العلاجات موجود في فاتورة سابقة"), 30000), "the second desk is refused: it is on an invoice already");
    check((await q(`select count(*)::int as n from invoices where patient_id = $1`, [p3.id]))[0].n === 1, "so the patient has one invoice, not two");

    await desk.goto(fileUrl(p3.id, "invoices"), { timeout: 120000 });
    await desk.waitForSelector(`a[href$='/invoices/${invoiceId}']`, { timeout: 60000 });
    await desk.waitForTimeout(500);
    check((await desk.locator("[data-ready-to-bill]").count()) === 0, "billed, the work leaves Ready to bill");

    // A void gives the work back, and the receptionist's open screen hears of it.
    await q(`update invoices set status = 'void' where id = $1`, [invoiceId]);
    check(
      await until(async () => (await desk.locator("[data-ready-to-bill]").getAttribute("data-ready-to-bill")) === "2", 20000),
      "voiding the invoice puts both back on Ready to bill — on the receptionist's open screen, without a reload"
    );

    // A new invoice made the usual way offers the chart's work, linked.
    const offered = desk.waitForResponse((r) => r.url().includes(`/patients/${p3.id}/dental/billable`), { timeout: 120000 });
    await desk.goto(`${BASE}/c/${slug}/invoices/new?patient=${p3.id}`, { timeout: 120000 });
    await offered;
    await desk.waitForSelector("[data-chart-offer]", { timeout: 30000 });
    check((await desk.locator("[data-chart-offer]").getAttribute("data-chart-offer")) === "2", "a new invoice for the patient offers both treatments From the chart");
    await desk.locator("[data-offer-all]").click();
    check(await until(async () => (await desk.locator("[data-chart-offer]").count()) === 0), "Add all writes both lines");
    await desk.getByRole("button", { name: "Create", exact: true }).click();
    await desk.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60000 });
    const invoice2 = new URL(desk.url()).pathname.split("/").pop()!;
    const linked2 = await q(`select iim.mark_id from invoice_item_marks iim join invoice_items ii on ii.id = iim.invoice_item_id where ii.invoice_id = $1`, [invoice2]);
    check(linked2.length === 2, "and an invoice made that way is linked like Bill's");
    const offeredAgain = desk.waitForResponse((r) => r.url().includes(`/patients/${p3.id}/dental/billable`), { timeout: 120000 });
    await desk.goto(`${BASE}/c/${slug}/invoices/new?patient=${p3.id}&marks=${crown16.id}`, { timeout: 120000 });
    await offeredAgain;
    await desk.waitForTimeout(400);
    check(
      (await lineValues(desk)).every((v) => !v.includes("tooth 16")) && (await desk.locator(`[data-offer-line='${crown16.id}']`).count()) === 0,
      "billed, the crown is offered nowhere again — not by Bill, not From the chart"
    );

    /* ── Charged per visit ────────────────────────────────────────────── */
    console.log("Charged per visit");
    await openFile(doc, fileUrl(p3.id));
    await planOn("11", "scaling", "scaling");
    const sc = await markOf("mouth", "scaling");
    check(sc?.fee === 30, "a cleaning is planned at 30", JSON.stringify(sc));
    await card.locator("[data-step-done='upper']").click();
    await settle(doc);
    await q(`update chart_mark_steps set done_at = now() - interval '2 days' where mark_id = $1 and step = 'upper'`, [sc.id]);
    await openFile(doc, fileUrl(p3.id));
    await openCard(doc, sc.id);
    if (!(await card.locator("[data-step-form='lower']").count())) await card.locator("[data-step='lower'] button").first().click();
    await card.locator("[data-step-done='lower']").click();
    await settle(doc);
    const perVisit = await billableLines();
    check(
      perVisit.length === 1 && perVisit[0].markId === sc.id && perVisit[0].qty === 2 && perVisit[0].unitPrice === 30,
      "done over two visits, it is billed as two visits at 30 — the billed crown and root canal are not offered",
      JSON.stringify(perVisit)
    );

    /* ── Notes from everywhere ───────────────────────────────────────── */
    console.log("Notes from everywhere");
    await desk.goto(fileUrl(p3.id, "notes"), { timeout: 120000 });
    await desk.waitForSelector("[data-feed-source='invoice']", { timeout: 60000 });
    const invNote = await desk.locator("[data-feed-source='invoice']").first().innerText();
    check(invNote.includes("Half paid in cash") && /INV|-\d{4}-/.test(invNote) && invNote.includes("Invoice"), "an invoice's note is in the patient's notes, saying it is the invoice's, by number", invNote);
    await deskAr.goto(fileUrl(p3.id, "notes"), { timeout: 120000 });
    await deskAr.waitForSelector("[data-feed-source='invoice']", { timeout: 60000 });
    check((await deskAr.locator("[data-feed-source='invoice']").first().innerText()).includes("فاتورة"), "and in Arabic it says فاتورة");

    await q(`update patients set notes_summary = 'Anxious; prefers morning visits' where id = $1`, [p2.id]);
    await doc.goto(fileUrl(p2.id, "notes"), { timeout: 120000 });
    await doc.waitForSelector("[data-feed-source]", { timeout: 60000 });
    const feedSources = await doc.locator("[data-feed-source]").evaluateAll((els) => els.map((e) => e.getAttribute("data-feed-source")));
    check(
      ["visit", "emergency"].every((s) => feedSources.includes(s)) && !feedSources.includes("case"),
      "the Notes tab gathers the visit's note and the emergency — and no case, there being none",
      feedSources.join(",")
    );
    check(
      (await doc.locator("[data-on-file-summary]").innerText()).includes("Anxious; prefers morning visits") && (await doc.locator("[data-on-file-medical]").count()) === 0,
      "with the Overview's summary on top, the medical history left to the Overview"
    );
    check((await doc.locator("[data-feed-source='emergency']").innerText()).includes("Swelling overnight"), "the emergency reads as it was recorded");
    // Open goes back to where the note lives: the emergency, to its root canal on the chart.
    await doc.locator("[data-feed-source='emergency'] [data-feed-open]").click();
    check(await until(async () => (await card.getAttribute("data-procedure")) === rct.id), "Open on the emergency goes to the Dental chart tab, its root canal open");
    // A note written on the chart is in Notes the moment the tab is opened.
    const noteBox = card.locator("label").filter({ has: doc.locator("span", { hasText: /^Note$/ }) }).locator("textarea");
    await noteBox.fill("Sensitive to cold after the filling");
    await noteBox.blur();
    await settle(doc);
    await doc.getByRole("tab", { name: "Notes" }).click();
    check(
      await until(async () => (await doc.locator("[data-feed-source='chart']").allInnerTexts()).some((x) => x.includes("Sensitive to cold after the filling"))),
      "a note written on the chart is in the Notes tab without a reload"
    );
    await doc.locator("[data-feed-source='visit'] [data-feed-open]").first().click();
    await doc.waitForURL(/\/calendar\?open=/, { timeout: 60000 });
    check(await until(async () => (await doc.locator("aside input[type='date']").inputValue()) === tomorrow, 30000), "Open on a visit's note opens that visit in the calendar");

    /* ── A treatment with no price ────────────────────────────────────── */
    console.log("A treatment with no price");
    const [p4] = await q(
      `insert into patients (clinic_id, full_name, birth_date, phone_e164, source, created_by) values ($1,'Nadia Saleh','1992-07-01','+962790007777','staff',$2) returning id`,
      [clinic.id, doctorUser]
    );
    await openFile(doc, fileUrl(p4.id));
    await tapTooth(doc, "38");
    await panelOf(doc).getByRole("radio", { name: "Planned" }).click();
    await pickIn(panelOf(doc), "extraction_surgical", "surgical");
    await settle(doc);
    const [ext] = await q(`select id, fee from chart_marks where patient_id = $1 and site = '38' and voided_at is null`, [p4.id]);
    check(ext && ext.fee === null, "a treatment with no price on the list is charted with none");
    check((await noPrices(doc)) && !(await doc.locator("main").innerText()).includes("No price"), "and the chart does not ask the doctor for one");
    await doc.goto(`${BASE}/c/${slug}/settings/prices`, { timeout: 120000 });
    await doc.waitForSelector("[data-dental-prices]", { timeout: 120000 });
    check(await until(async () => (await doc.locator("[data-needs-row='extraction_surgical:']").count()) === 1), "it waits on the price list, under Needs a price");
    const needsBox = doc.locator("[data-needs-row='extraction_surgical:'] [data-price-box]");
    await needsBox.fill("40");
    await needsBox.press("Enter");
    check(await until(async () => (await servicePrice("extraction_surgical", null))?.price === 40, 20000), "priced there at 40");
    check(await until(async () => (await q(`select fee::float as fee from chart_marks where id = $1`, [ext.id]))[0].fee === 40), "and the extraction already charted takes it");

    /* ── The tooth, small or in full ──────────────────────────────────── */
    console.log("The tooth, small or in full");
    await openFile(doc, fileUrl(p4.id));
    // 38 has the surgical extraction planned above: the compact panel puts it before the treatments.
    await tapTooth(doc, "38");
    check(
      (await doc.locator("[data-panel-size='compact']").count()) === 1 && (await doc.locator("[data-compact-tooth]").count()) === 1,
      "a tooth opens the compact panel: a small tooth on one line"
    );
    check(
      await doc.locator("[data-panel-size='compact']").evaluate((root) => {
        const todo = root.querySelector("[data-tooth-todo]");
        const search = root.querySelector("input[type='search']");
        return !!todo && !!search && !!(todo.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
      "and what is to be done on the tooth comes before the list of treatments"
    );
    await doc.locator("[data-expand-panel]").first().click();
    const full = doc.locator("[role='dialog'] [data-panel-size='big']");
    await full.waitFor({ timeout: 10000 });
    check(
      (await full.locator("[data-tooth-pane='tooth']").count()) === 1 && (await full.locator("[data-tooth-pane='tooth'] [data-treatment]").count()) === 0,
      "Expand opens the tooth's full view — the tooth, not the list of treatments"
    );
    check(
      (await full.locator("[data-tooth-todo] [data-mark]").count()) === 1 && (await full.locator("[data-tooth-summary]").innerText()).includes("1 to do"),
      "what is to be done on it comes first, and the header says how much"
    );
    check((await full.locator("[data-tooth-emergency]").count()) === 1, "an emergency on the tooth is one button away");
    // Along the arch without closing: 38 is the last tooth, so the way is back, to 37.
    check(await full.locator("[data-go-tooth='next']").isDisabled(), "past the last tooth there is nowhere to go");
    await full.locator("[data-go-tooth='prev']").click();
    check(await until(async () => (await full.innerText()).includes("Lower left second molar")), "the arrow walks to 37 without closing the window");
    await full.locator("[data-add-treatment]").click();
    check((await full.locator("[data-tooth-pane='add'] [data-treatment]").count()) > 8, "Add treatment lays every treatment out wide");
    await full.getByRole("radio", { name: "Done" }).click();
    await pickIn(full, "extraction", "simple extraction");
    // The undo lasts six seconds: looked for at once, before waiting on the save.
    check(await until(() => doc.locator("[data-undo-pill]").isVisible(), 4000), "its undo shows over the window");
    check(await until(async () => (await full.locator("[data-tooth-pane='tooth']").count()) === 1), "and the window goes back to the tooth, where the extraction now is");
    await settle(doc);
    check(
      (await q(`select count(*)::int as n from chart_marks where patient_id = $1 and site = '37' and treatment_key = 'extraction' and status = 'done'`, [p4.id]))[0].n === 1,
      "a treatment picked in the full view is recorded"
    );
    // A treatment with steps opens them in the same window, and goes back to the tooth.
    await full.locator("[data-go-tooth='prev']").click();
    check(await until(async () => (await full.innerText()).includes("Lower left first molar")), "on to 36");
    await full.locator("[data-add-treatment]").click();
    await full.getByRole("radio", { name: "Planned" }).click();
    await pickIn(full, "rct", "root canal");
    check(await until(async () => (await full.locator("[data-tooth-pane='card'] [data-procedure]").count()) === 1), "a root canal opens its steps in the same window");
    await full.locator("[data-procedure] [data-card-back]").first().click();
    check(await until(async () => (await full.locator("[data-tooth-pane='tooth'] [data-tooth-todo] [data-mark]").count()) === 1), "and back on the tooth, it is the work to do");
    await doc.keyboard.press("Escape");
    await tapTooth(doc, "24");
    check((await doc.locator("[role='dialog'] [data-panel-size='big']").count()) === 1, "the choice is remembered: the next tooth opens in full");
    await doc.locator("[data-expand-panel]").first().click();
    check(await until(async () => (await doc.locator("[data-panel-size='compact']").count()) === 1), "and Smaller puts it back beside the chart");
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
