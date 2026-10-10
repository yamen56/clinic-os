/**
 * The dental chart, saved: every patient has their own chart that the clinic
 * can open, x-rays and photos land in the patient's Files, and the imaging
 * station answers "Take x-ray" from the chair.
 *
 * Fixtures: a dental clinic with the module on, a doctor (records), a
 * receptionist without `patients.charts` (reads only), a clinic with the module
 * off, and a super-admin for the new-clinic form. Screenshots go to
 * scripts/qa-shots/dental/.
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
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "dental");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

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

async function signIn(browser: Browser, email: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, permissions: ["camera"] });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  // Twice before giving up: the dev server is shared, and a sign-in that lands
  // while it recompiles can stall and then pass at once on a second try.
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.waitForLoadState("networkidle");
    // The first attempt can land after all, slowly: then /login sends us on.
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
async function openChart(page: Page, url: string) {
  await page.goto(url, { timeout: 120000 });
  await page.waitForSelector("[data-dental-chart] [data-tooth='16']", { timeout: 120000 });
  await page.waitForTimeout(500);
}
/** The tooth panel, beside the chart on a desktop. */
const panelOf = (p: Page) => p.locator("[data-dental-panel]").first();
async function tapTooth(page: Page, fdi: string) {
  await chart(page).locator(`[data-tooth='${fdi}']`).first().click();
  await panelOf(page).waitFor({ timeout: 10000 });
}
/** Find a treatment by name in a picker, tap it, and clear the search. */
async function pickIn(scope: ReturnType<Page["locator"]>, key: string, query: string) {
  const search = scope.locator("input[type='search']").first();
  await search.fill(query);
  await scope.locator(`[data-treatment='${key}']`).first().click();
  if (await search.count()) await search.fill("").catch(() => {});
}
/** Wait until the server has the rows the screen already shows. */
const inflight = new WeakMap<Page, number>();
/** Count the page's API calls in flight, so `settle` can wait for the saves behind a tap. */
function track(page: Page) {
  inflight.set(page, 0);
  const api = (u: string) => u.includes("/api/");
  page.on("request", (r) => api(r.url()) && inflight.set(page, (inflight.get(page) ?? 0) + 1));
  const done = (r: { url(): string }) => api(r.url()) && inflight.set(page, Math.max(0, (inflight.get(page) ?? 0) - 1));
  page.on("requestfinished", done);
  page.on("requestfailed", done);
}
/*
  `waitForLoadState("networkidle")` returns at once on a page that was idle
  before, so it cannot wait for the save a tap starts: the tap's own calls are
  counted instead, and a moment more is allowed for one that follows another
  (an upload, then the teeth it is labelled with).
*/
async function settle(page: Page) {
  const end = Date.now() + 20000;
  for (let quiet = 0; quiet < 3 && Date.now() < end; ) {
    await page.waitForTimeout(120);
    quiet = (inflight.get(page) ?? 0) === 0 ? quiet + 1 : 0;
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  const [dentalClinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features) values ('QA Teeth','عيادة الأسنان',$1,'dental','{dental}','{"dental": true}') returning id`,
    [`qateeth${tag}`]
  );
  const [plainClinic] = await q(`insert into clinics (name, name_ar, slug, specialty, features) values ('QA Skin','جلدية',$1,'dermatology','{}') returning id`, [`qaskin${tag}`]);
  for (const c of [dentalClinic, plainClinic]) await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [c.id]);

  const user = async (email: string, name: string, admin = false) =>
    (
      await q(
        `insert into users (email, password_hash, full_name, locale, is_super_admin, admin_permissions) values ($1,$2,$3,'en',$4,$5) returning id`,
        [email, hash, name, admin, admin ? '{"level":"full"}' : '{}']
      )
    )[0].id as string;
  const doctorUser = await user(`teeth-doc-${tag}@test.local`, "Dr. Lina Mansour");
  const deskUser = await user(`teeth-desk-${tag}@test.local`, "Desk Rana");
  const adminUser = await user(`teeth-admin-${tag}@test.local`, "QA Admin", true);
  const [doctorMember] = await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}') returning id`,
    [dentalClinic.id, doctorUser]
  );
  // A receptionist who opens files but may not record on the chart.
  await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',false,'{"level":"custom","caps":{"dashboard":true,"patients":true,"patients.charts":false}}')`,
    [dentalClinic.id, deskUser]
  );
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}')`, [plainClinic.id, doctorUser]);
  const [patient] = await q(`insert into patients (clinic_id, full_name, birth_date, phone_e164, source) values ($1,'Rami Khatib','1988-03-14','+962790000555','staff') returning id`, [dentalClinic.id]);
  const [plainPatient] = await q(`insert into patients (clinic_id, full_name, source) values ($1,'Skin Patient','staff') returning id`, [plainClinic.id]);
  const fileUrl = `${BASE}/c/qateeth${tag}/patients/${patient.id}?tab=dental`;

  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const errors: string[] = [];
  try {
    /* ── The doctor charts, and it stays charted ─────────────────────── */
    const page = await signIn(browser, `teeth-doc-${tag}@test.local`);
    page.on("pageerror", (e) => errors.push(e.message));
    track(page);
    await openChart(page, fileUrl);
    check((await page.locator('[role="tablist"]').first().innerText()).includes("Dental chart"), "a dental clinic's patient file has the Dental chart tab");
    check((await page.locator("[data-dental-chart]").getAttribute("data-can-write")) !== null, "a doctor may record on the chart");

    await tapTooth(page, "47");
    const panel = panelOf(page);
    await panel.locator("[data-surface-chip='O']").click();
    await panel.locator("[data-surface-chip='M']").click();
    await pickIn(panel, "filling_composite", "composite");
    await settle(page);
    let rows = await q(`select m.*, (select count(*)::int from chart_mark_events e where e.mark_id = m.id) as events from chart_marks m where patient_id = $1`, [patient.id]);
    check(
      rows.length === 1 && rows[0].site === "47" && rows[0].surfaces.join("") === "OM" && rows[0].performed_by === doctorMember.id && rows[0].recorded_by === doctorUser && rows[0].events === 1,
      "a filling tapped on 47 is saved on the patient, with the doctor who did it and its history line",
      JSON.stringify(rows.map((r) => ({ site: r.site, surfaces: r.surfaces, by: r.performed_by, events: r.events })))
    );
    await openChart(page, fileUrl);
    await tapTooth(page, "47");
    check(/Composite filling · MO/.test(await panel.innerText()), "after a reload the filling is still on 47");
    check((await chart(page).locator("[data-tooth='47'] .tooth-pop").count()) > 0, "and still drawn on the tooth");

    // Planned, then done.
    await page.getByRole("radio", { name: "Planned" }).first().click();
    await tapTooth(page, "36");
    await pickIn(panel, "rct", "root canal");
    await settle(page);
    await page.getByRole("radio", { name: "Done" }).first().click();
    await panel.locator("[data-mark] button", { hasText: "Mark done" }).first().click();
    await settle(page);
    rows = await q(`select status, done_at, (select array_agg(action order by at) from chart_mark_events e where e.mark_id = m.id) as actions from chart_marks m where patient_id = $1 and site = '36'`, [patient.id]);
    check(rows.length === 1 && rows[0].status === "done" && rows[0].done_at && rows[0].actions.join(",") === "created,done", "a planned root canal marked done is saved as done, with both history lines", JSON.stringify(rows));

    // Undo takes a mis-tap back from the database too.
    await tapTooth(page, "44");
    await pickIn(panel, "extraction", "simple extraction");
    await page.getByRole("button", { name: "Undo" }).click();
    await settle(page);
    rows = await q(`select 1 from chart_marks where patient_id = $1 and site = '44'`, [patient.id]);
    check(rows.length === 0, "undo removes the mis-tapped extraction from the patient's chart");

    // Void with a reason: off the chart, kept in the record.
    await tapTooth(page, "47");
    await panel.locator("[data-mark] button").filter({ has: page.locator("svg.lucide-chevron-down") }).first().click();
    await panel.getByRole("button", { name: "Void" }).click();
    await page.getByRole("dialog").locator("input").fill("Charted on the wrong tooth");
    await page.getByRole("dialog").getByRole("button", { name: "Void entry" }).click();
    await settle(page);
    rows = await q(`select voided_at, void_reason, voided_by from chart_marks where patient_id = $1 and site = '47'`, [patient.id]);
    check(rows[0]?.voided_at && rows[0].void_reason === "Charted on the wrong tooth" && rows[0].voided_by === doctorUser, "voiding keeps the entry, with who voided it and why");

    // Favourites are the clinic's, with a name on them.
    await tapTooth(page, "26");
    await panel.locator("input[type='search']").first().fill("crown");
    await panel.locator("[data-treatment='crown']").first().locator("xpath=..").locator("button[aria-pressed]").click();
    await panel.locator("input[type='search']").first().fill("");
    await settle(page);
    rows = await q(`select treatment_key, added_by from chart_treatment_favorites where clinic_id = $1`, [dentalClinic.id]);
    check(rows.length === 1 && rows[0].treatment_key === "crown" && rows[0].added_by === doctorUser, "starring a treatment saves it to the clinic's favourites, with who added it");

    // A treatment of the clinic's own.
    await panel.getByRole("button", { name: "Add a treatment" }).click();
    await page.getByRole("dialog").locator("input").first().fill("Fiber post");
    await page.getByRole("dialog").getByRole("button", { name: "Add treatment" }).click();
    await settle(page);
    rows = await q(`select name, created_by from chart_treatments where clinic_id = $1`, [dentalClinic.id]);
    check(rows.length === 1 && rows[0].name === "Fiber post" && rows[0].created_by === doctorUser, "a doctor's own treatment joins the clinic's catalog");

    // The whole mouth.
    await page.keyboard.press("Escape");
    await chart(page).locator("[data-region-pill='add']").click();
    await pickIn(page.getByRole("dialog"), "scaling", "scaling");
    await settle(page);
    rows = await q(`select site, status from chart_marks where patient_id = $1 and treatment_key = 'scaling'`, [patient.id]);
    check(rows.length === 1 && rows[0].site === "mouth", "a cleaning for the whole mouth is saved on the mouth");

    // Brush: missing on 28.
    await page.getByRole("radio", { name: "Brush" }).click();
    await page.locator("[data-dental-panel]").getByRole("tab", { name: "Findings" }).click();
    await page.locator("[data-dental-panel] [data-treatment='missing']").first().click();
    await chart(page).locator("[data-tooth='28']").first().click();
    await settle(page);
    await page.getByRole("radio", { name: "Tooth" }).click();
    rows = await q(`select status, kind from chart_marks where patient_id = $1 and site = '28' and treatment_key = 'missing'`, [patient.id]);
    check(rows.length === 1 && rows[0].kind === "finding", "the brush saves 'missing' on 28 as a finding");

    await openChart(page, fileUrl);
    check(
      (await chart(page).locator("[data-tooth='28'][data-gone]").count()) === 1 && (await chart(page).locator("[data-region-pill='mouth']").count()) === 1,
      "after a reload the chart shows everything saved: 28 gone, the cleaning on the mouth"
    );
    const history = await page.locator("[data-dental-chart]").innerText();
    check(/Root canal treatment[\s\S]*Marked done/.test(history) && /Composite filling · MO[\s\S]*Voided/.test(history), "the history lists what happened, from the database");
    await page.screenshot({ path: join(SHOTS, "saved-desktop-chart.png"), fullPage: true });

    /* ── X-rays and photos, into the patient's Files ────────────────── */
    await tapTooth(page, "36");
    await panel.locator("[data-tooth-image-section] input[type='file']").first().setInputFiles({ name: "pa-36.png", mimeType: "image/png", buffer: PNG });
    await settle(page);
    // The upload and the label are two calls; the second can start after `settle` saw quiet.
    for (let end = Date.now() + 10000; ; ) {
      rows = await q(`select kind, teeth from patient_files where patient_id = $1`, [patient.id]);
      if ((rows.length === 1 && rows[0].teeth.join() === "36") || Date.now() > end) break;
      await page.waitForTimeout(300);
    }
    check(rows.length === 1 && rows[0].kind === "xray" && rows[0].teeth.join() === "36", "an x-ray added from tooth 36 is a patient file of kind x-ray, labelled 36", JSON.stringify(rows));
    check((await chart(page).locator("[data-tooth='36'] [data-tooth-images]").count()) === 1, "36 carries a picture badge");

    // The camera: Chromium's fake camera stands in for an intraoral one.
    await panel.locator("[data-add-image='camera']").click();
    const cam = page.locator("[data-camera]");
    await cam.waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await cam.getByRole("button", { name: "Capture" }).click();
    await cam.getByRole("button", { name: "Save photo" }).click();
    await settle(page);
    rows = await q(`select kind, teeth, mime_type from patient_files where patient_id = $1 and kind = 'photo'`, [patient.id]);
    check(rows.length === 1 && rows[0].teeth.join() === "36" && rows[0].mime_type === "image/jpeg", "a photo from the camera is saved to the patient's files, labelled 36", JSON.stringify(rows));

    /* ── Before and after, and the picture to the patient ───────────── */
    await panel.locator("[data-image]").first().click();
    const viewerEl = page.locator("[data-image-viewer]");
    await viewerEl.waitFor({ timeout: 10000 });
    await viewerEl.locator("[data-compare]").click();
    await viewerEl.locator("[data-compare-view] img").nth(1).waitFor({ timeout: 10000 });
    check((await viewerEl.locator("[data-compare-view] img").count()) === 2, "Compare puts two pictures of 36 side by side, each with its date");
    await page.screenshot({ path: join(SHOTS, "compare.png") });
    await viewerEl.locator("[data-compare]").click();
    await viewerEl.locator("[data-send-patient]").click();
    const sendDialog = page.locator("[data-send-dialog]");
    await sendDialog.waitFor({ timeout: 10000 });
    check((await sendDialog.locator("[data-send-caption]").inputValue()).includes("QA Teeth"), "Send to patient opens with a caption naming the clinic, ready to change");
    await sendDialog.locator("[data-send-confirm]").click();
    await page.getByText("WhatsApp is not connected").first().waitFor({ timeout: 10000 });
    check(true, "with the clinic's WhatsApp not connected, it says so instead of pretending to send");
    await page.keyboard.press("Escape");
    await sendDialog.waitFor({ state: "detached", timeout: 5000 });
    check((await viewerEl.count()) === 1, "Escape closes the send box and leaves the x-ray open");
    await page.keyboard.press("Escape");
    await viewerEl.waitFor({ state: "detached", timeout: 5000 });
    check((await panelOf(page).count()) > 0, "and closing the x-ray leaves the tooth's panel where the doctor left it");

    /* ── "Take x-ray": the station sends the machine's next image ─────── */
    await panel.locator("[data-take-xray]").click();
    await page.locator("[data-xray-pending]").waitFor({ timeout: 10000 });
    ok("Take x-ray on 36 leaves the chart waiting on the imaging station");
    const station = await page.context().newPage();
    await station.goto(`${BASE}/c/qateeth${tag}/devices`, { timeout: 120000 });
    await station.locator("[data-request]").first().waitFor({ timeout: 30000 });
    check(/Rami Khatib · 36/.test(await station.locator("[data-requests]").innerText()), "the station shows who is waiting: the patient and the tooth");
    await station.locator("[data-imaging-station] input[type='file']").setInputFiles({ name: "IMG_0042.png", mimeType: "image/png", buffer: PNG });
    await station.locator("[data-sent]").waitFor({ timeout: 30000 });
    await page.locator("[data-image-viewer]").waitFor({ timeout: 20000 });
    ok("the image the station sent opens on the doctor's chart by itself");
    rows = await q(
      `select f.kind, f.teeth, r.fulfilled_at from imaging_requests r join patient_files f on f.id = r.file_id where r.patient_id = $1`,
      [patient.id]
    );
    check(rows.length === 1 && rows[0].kind === "xray" && rows[0].teeth.join() === "36" && rows[0].fulfilled_at, "the station's image is in the patient's files, labelled 36, and the request answered");
    await page.screenshot({ path: join(SHOTS, "saved-xray-from-station.png") });
    await page.keyboard.press("Escape");
    await station.screenshot({ path: join(SHOTS, "imaging-station.png"), fullPage: true });
    await station.close();

    // In the Files tab too, with its teeth.
    await page.goto(`${BASE}/c/qateeth${tag}/patients/${patient.id}?tab=files`, { timeout: 120000 });
    await page.waitForSelector("[data-file-teeth]", { timeout: 60000 });
    check((await page.locator("[data-file-teeth]").count()) === 3, "the Files tab lists the chart's images with the teeth they show");
    await page.context().close();

    /* ── Reading without recording ───────────────────────────────────── */
    const desk = await signIn(browser, `teeth-desk-${tag}@test.local`);
    desk.on("pageerror", (e) => errors.push(`[desk] ${e.message}`));
    track(desk);
    await openChart(desk, fileUrl);
    check((await desk.locator("[data-dental-chart] [data-read-only]").count()) > 0 && (await desk.getByRole("radio", { name: "Brush" }).count()) === 0, "a receptionist without the chart capability reads the chart and cannot record");
    await chart(desk).locator("[data-tooth='36']").first().click();
    check((await panelOf(desk).locator("[data-treatment]").count()) === 0, "her tooth panel offers no treatments");
    const denied = await desk.evaluate(
      `fetch("/api/c/qateeth${tag}/patients/${patient.id}/dental/marks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marks: [{ id: "${crypto.randomUUID()}", eventId: "${crypto.randomUUID()}", site: "11", treatmentKey: "caries", status: "existing" }] }) }).then((r) => r.status)`
    );
    check(denied === 403, "and the server refuses her a chart entry", String(denied));
    await desk.context().close();

    /* ── A clinic without the module ─────────────────────────────────── */
    const other = await signIn(browser, `teeth-doc-${tag}@test.local`);
    await other.goto(`${BASE}/c/qaskin${tag}/patients/${plainPatient.id}?tab=dental`, { timeout: 120000 });
    await other.waitForSelector('[role="tablist"]', { timeout: 120000 });
    check(!(await other.locator('[role="tablist"]').first().innerText()).includes("Dental chart"), "a clinic with the dental chart switched off shows no tab");

    /* ── Phone: the panel docks, the tooth stays in view ─────────────── */
    await other.setViewportSize({ width: 390, height: 844 });
    await openChart(other, fileUrl);
    await other.getByRole("radio", { name: "Patient's left" }).click();
    await chart(other).locator("[data-tooth='36']").first().click();
    await other.locator("[data-dental-sheet]").waitFor({ timeout: 10000 });
    await other.waitForTimeout(600);
    await other.screenshot({ path: join(SHOTS, "saved-phone-tooth36.png") });
    ok("on a phone the saved chart opens the docked panel");
    await other.context().close();

    /* ── The agency's switch ─────────────────────────────────────────── */
    const admin = await signIn(browser, `teeth-admin-${tag}@test.local`);
    await admin.goto(`${BASE}/admin/clinics/new`, { timeout: 120000 });
    const sw = admin.getByRole("switch", { name: "Dental chart" });
    await sw.waitFor({ timeout: 60000 });
    check((await sw.getAttribute("aria-checked")) === "false", "a new clinic starts with the dental chart off");
    await admin.locator("select[name='specialty']").selectOption("dental");
    check((await sw.getAttribute("aria-checked")) === "true", "choosing Dental as the specialty switches the dental chart on");
    await sw.click();
    check((await sw.getAttribute("aria-checked")) === "false", "and it can still be switched off");
    await admin.screenshot({ path: join(SHOTS, "admin-new-clinic.png"), fullPage: true });
    await admin.context().close();

    if (errors.length === 0) ok("no page errors");
    else for (const e of errors) fail(`page error ${e}`);
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = any($1::uuid[])`, [[dentalClinic.id, plainClinic.id]]);
    await db.query(`delete from users where id = any($1::uuid[])`, [[doctorUser, deskUser, adminUser]]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
