/**
 * Yamen's list of 2026-11-02, end to end in a browser:
 *
 *  - Running late: reception notes how late a patient is; the patients after
 *    them with the same doctor can be told on WhatsApp — only those ticked,
 *    only once — and nobody's booking moves. "Save only" sends nothing.
 *  - The Today board takes a card dragged to another column: forward is the
 *    next step, one back is Undo, Finished asks first; on a phone, a press and
 *    hold picks the card up and the column tabs take the drop.
 *  - Ready to bill opens minimised, and takes an item (or a patient's whole
 *    list) off in one tap, with Undo putting back exactly the price it had.
 *  - Request from device and Take x-ray are gone.
 *  - Pictures say what they are (panoramic, bitewing…), are adjusted and
 *    drawn on in the viewer, and Save writes a new picture beside the
 *    original — which is untouched — that Save & send sends.
 */
import { Client } from "pg";
import { chromium, devices, type Page } from "playwright";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import { viewFor } from "../src/lib/imaging/kinds";

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
function check(ok: unknown, name: string, detail = "") {
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
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 90_000 });
}

/** A mouse drag in small steps, the way a hand moves. */
async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
  await page.waitForTimeout(150);
  await page.mouse.up();
}

const centre = async (page: Page, sel: string, dy = 0) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 24) + dy };
};

async function main() {
  // What the file names say, before any browser.
  console.log("\n[an x-ray's view from where it came from]");
  check(viewFor({ deviceKind: "opg" }) === "panoramic" && viewFor({ deviceKind: "cbct" }) === "cbct", "a panoramic machine sends panoramics, a cone beam CBCT");
  check(viewFor({ modality: "PX" }) === "panoramic", "a DICOM that says PX is a panoramic");
  check(
    viewFor({ fileName: "CLN1042_PAN.jpg" }) === "panoramic" &&
      viewFor({ fileName: "BW left.png" }) === "bitewing" &&
      viewFor({ fileName: "PA-36.png" }) === "periapical" &&
      viewFor({ fileName: "IMG_0042.png" }) === null,
    "and the file's own name says the rest — or nothing"
  );

  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
  const tag = Date.now().toString(36);
  const slug = `qalate${tag}`;
  const userIds: string[] = [];
  const [clinic] = await q(
    `insert into clinics (name, slug, timezone, working_hours, specialty, specialties, features, dental_billing_since)
     values ('QA Late', $1, $2, $3, 'dental', '{dental}', '{"dental": true}', now() - interval '7 days') returning id`,
    [slug, TZ, ALL_DAY]
  );
  await q(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [clinic.id]);
  const mkUser = async (who: string, name: string) => {
    const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [
      `${who}-${slug}@test.local`,
      bcrypt.hashSync("password123", 10),
      name,
    ]);
    userIds.push(u.id);
    return u.id as string;
  };
  const deskUser = await mkUser("desk", "QA Desk");
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [clinic.id, deskUser]);
  const mkDoc = async (who: string, name: string) =>
    (await q(`insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'doctor', '{"level":"full"}') returning id`, [clinic.id, await mkUser(who, name)]))[0]
      .id as string;
  const rana = await mkDoc("rana", "Dr Rana");
  const omarDoc = await mkDoc("fadi", "Dr Fadi");
  const [svc] = await q(`insert into services (clinic_id, name, duration_min, price) values ($1, 'Check-up', 30, 20) returning id`, [clinic.id]);
  const mkPatient = async (name: string, phone: string | null) =>
    (await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`, [clinic.id, name, phone]))[0].id as string;
  const lina = await mkPatient("Lina Saleh", "+962790771101");
  const omar = await mkPatient("Omar Nabulsi", "+962790771102");
  const huda = await mkPatient("Huda Rawashdeh", "+962790771103");
  const zaid = await mkPatient("Zaid Other", "+962790771104");
  /** Today, `mins` from now (negative: already started). */
  const book = async (p: string, doc: string, mins: number) =>
    (
      await q(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, now() + make_interval(mins => $5), now() + make_interval(mins => $5 + 30), 'confirmed') returning id`,
        [clinic.id, p, doc, svc.id, mins]
      )
    )[0].id as string;
  // Keep every visit inside today in Amman, whatever the hour the test runs.
  const [{ left }] = await q(`select extract(epoch from (date_trunc('day', now() at time zone $1) + interval '1 day' - (now() at time zone $1))) / 60 as left`, [TZ]);
  const room = Math.max(0, Math.min(150, Number(left) - 35));
  const linaAppt = await book(lina, rana, -30);
  const omarAppt = await book(omar, rana, Math.round(room * 0.4) + 1);
  const hudaAppt = await book(huda, rana, Math.round(room * 0.8) + 2);
  const zaidAppt = await book(zaid, omarDoc, Math.round(room * 0.6) + 1);

  const browser = await chromium.launch();
  const errors: string[] = [];
  const watch = (p: Page) => {
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/.test(m.text()) && errors.push(`[console] ${m.text().slice(0, 600)}`));
  };
  const base = `${BASE}/c/${slug}`;
  const card = (page: Page, id: string) => page.locator(`[data-flow-card="${id}"]`);
  const appt = async (id: string) =>
    (await q(`select status, arrived_at, seated_at, finished_at, late_min, delay_notice_at from appointments where id = $1`, [id]))[0];
  const sentTo = async (phone: string) =>
    q(
      `select m.body, m.msg_type from messages m join conversations c on c.id = m.conversation_id
        where c.clinic_id = $1 and c.phone_e164 = $2 and m.direction = 'out' order by m.created_at`,
      [clinic.id, phone]
    );

  try {
    /* ============================================================ running late */
    console.log("\n[running late]");
    const startsBefore = (await q(`select id, starts_at from appointments where clinic_id = $1 order by id`, [clinic.id])).map((r) => `${r.id}:${r.starts_at.toISOString()}`).join();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const desk = await ctx.newPage();
    watch(desk);
    await signIn(desk, `desk-${slug}@test.local`);
    await desk.goto(`${base}/calendar`);
    await desk.waitForSelector(`[data-flow-card="${linaAppt}"][data-stage="late"]`, { timeout: 90_000 });
    check((await card(desk, linaAppt).locator("[data-flow-late]").count()) === 1, "a late patient's card offers Running late beside Arrived");
    await card(desk, linaAppt).locator("[data-flow-late]").click();
    const sheet = desk.locator("[data-late-sheet]");
    await sheet.waitFor({ timeout: 10_000 });
    check((await sheet.locator('[data-late-minutes="30"]').getAttribute("aria-checked")) === "true", "it starts at how late they are by the clock, rounded to five");
    check(
      (await sheet.locator(`[data-late-next="${omarAppt}"]`).count()) === 1 &&
        (await sheet.locator(`[data-late-next="${hudaAppt}"]`).count()) === 1 &&
        (await sheet.locator(`[data-late-next="${zaidAppt}"]`).count()) === 0,
      "it lists the same doctor's later patients today — not another doctor's"
    );
    await sheet.locator('[data-late-minutes="45"]').click();
    await sheet.locator(`[data-late-next="${hudaAppt}"] input`).uncheck();
    check((await sheet.locator("[data-late-tell]").innerText()).includes("Save and tell 1"), "the button counts who will be told");
    await sheet.locator("[data-late-tell]").click();
    await sheet.waitFor({ state: "detached", timeout: 30_000 });
    const l1 = await appt(linaAppt);
    check(l1.late_min === 45, "the minutes are saved on the late patient's visit", JSON.stringify(l1));
    const toOmar = await sentTo("+962790771102");
    // In the clinic's language — Arabic unless it chose English.
    check(toOmar.length === 1 && toOmar[0].body.includes("45") && toOmar[0].body.includes("Omar"), "the ticked patient is sent a WhatsApp naming the wait", JSON.stringify(toOmar));
    check((await sentTo("+962790771103")).length === 0 && (await sentTo("+962790771104")).length === 0, "the unticked one and the other doctor's are not");
    check((await appt(omarAppt)).delay_notice_at && !(await appt(hudaAppt)).delay_notice_at, "who was told is kept");
    const startsAfter = (await q(`select id, starts_at from appointments where clinic_id = $1 order by id`, [clinic.id])).map((r) => `${r.id}:${r.starts_at.toISOString()}`).join();
    check(startsAfter === startsBefore, "nobody's booking moved");
    check(await until(async () => (await card(desk, linaAppt).innerText()).includes("45 min late")), "Lina's card says 45 min late");
    check(await until(async () => (await card(desk, omarAppt).innerText()).includes("Told of a delay")), "Omar's card says he was told");

    // Again: whoever was told is not ticked twice; Save only sends nothing.
    await card(desk, linaAppt).locator("[data-flow-late]").click();
    await sheet.waitFor();
    check(
      !(await sheet.locator(`[data-late-next="${omarAppt}"] input`).isChecked()) && (await sheet.locator(`[data-late-next="${omarAppt}"]`).innerText()).includes("told"),
      "someone told already is listed, unticked, with when"
    );
    await sheet.locator("[data-late-custom]").fill("50");
    await sheet.locator("[data-late-save-only]").click();
    await sheet.waitFor({ state: "detached", timeout: 30_000 });
    check((await appt(linaAppt)).late_min === 50 && (await sentTo("+962790771103")).length === 0, "Save only writes the minutes and sends nothing");

    /* ============================================================ drag and drop */
    console.log("\n[dragging cards on the board]");
    const col = (c: string) => `[data-flow-column="${c}"]`;
    const dragTo = async (id: string, c: string) => mouseDrag(desk, await centre(desk, `[data-flow-card="${id}"]`), await centre(desk, col(c), 40));
    await dragTo(omarAppt, "waiting");
    check(await until(async () => !!(await appt(omarAppt)).arrived_at), "Coming → Waiting marks the patient arrived");
    await desk.waitForSelector(`[data-flow-card="${omarAppt}"][data-stage="waiting"]`, { timeout: 15_000 });
    await dragTo(omarAppt, "in_room");
    check(await until(async () => !!(await appt(omarAppt)).seated_at, 45_000), "Waiting → In room calls them in");
    await desk.waitForSelector(`[data-flow-card="${omarAppt}"][data-stage="in_room"]`, { timeout: 15_000 });
    await dragTo(omarAppt, "coming");
    await desk.waitForTimeout(800);
    check(!!(await appt(omarAppt)).seated_at && !!(await appt(omarAppt)).arrived_at, "two columns back is not a drop: nothing changes");
    await dragTo(omarAppt, "finished");
    await desk.waitForSelector("[data-finish-sheet]", { timeout: 10_000 });
    check(true, "dropping on Finished asks first, on the finish sheet");
    await desk.click("[data-finish-skip]");
    check(await until(async () => (await appt(omarAppt)).status === "completed"), "and Skip finishes the visit");
    await desk.waitForSelector(`[data-flow-card="${omarAppt}"][data-stage="finished"]`, { timeout: 15_000 });
    await dragTo(omarAppt, "in_room");
    check(await until(async () => (await appt(omarAppt)).status === "confirmed"), "Finished → In room is Undo");
    await desk.waitForSelector(`[data-flow-card="${omarAppt}"][data-stage="in_room"]`, { timeout: 15_000 });
    // A plain click on the card still opens the visit.
    await card(desk, omarAppt).locator("button").first().click();
    check(await until(async () => (await desk.getByRole("dialog").count()) > 0 || (await desk.locator("aside").filter({ hasText: "Omar" }).count()) > 0, 10_000), "a click without a drag still opens the visit");
    await desk.keyboard.press("Escape");
    await ctx.close();

    console.log("\n[on a phone: press, hold, and drop on a tab]");
    const phCtx = await browser.newContext({ ...devices["iPhone 13"] });
    const ph = await phCtx.newPage();
    watch(ph);
    await signIn(ph, `desk-${slug}@test.local`);
    await ph.goto(`${base}/calendar`);
    await ph.waitForSelector(`[data-flow-card="${hudaAppt}"]`, { state: "visible", timeout: 90_000 });
    const cdp = await phCtx.newCDPSession(ph);
    // Her card in the middle of the screen; the column tabs are scrolled away above it.
    await ph.evaluate(`document.querySelector('[data-flow-card="${hudaAppt}"]').scrollIntoView({ block: "center" })`);
    await ph.waitForTimeout(300);
    const from = await centre(ph, `[data-flow-card="${hudaAppt}"]`);
    const touch = async (type: "touchStart" | "touchMove", x: number, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
    const slide = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
      for (let i = 1; i <= 12; i++) await touch("touchMove", a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
    };
    await touch("touchStart", from.x, from.y);
    await ph.waitForTimeout(600);
    const board = ph.locator("[data-flow-board]");
    check((await board.getAttribute("data-dragging")) === hudaAppt, "holding the card still picks it up");
    // Held at the top edge, the board scrolls up by itself to the tabs.
    const edge = { x: from.x, y: 24 };
    await slide(from, edge);
    await ph.waitForTimeout(2500);
    const to = await centre(ph, '[role="tab"][data-drop-col="waiting"]', -10);
    check(to.y > 0, "holding the card at the top edge scrolls the board up to the tabs", JSON.stringify(to));
    await slide(edge, to);
    await ph.waitForTimeout(200);
    check((await board.getAttribute("data-drag-over")) === "waiting", "over the Waiting tab, it can go there", String(await board.getAttribute("data-drag-over")));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    check(await until(async () => !!(await appt(hudaAppt)).arrived_at), "a press-and-hold drag onto the Waiting tab marks her arrived");
    // A quick swipe is still a scroll, not a drag. (With someone waiting now, the phone shows Waiting: back to Coming.)
    await ph.click('[role="tab"][data-drop-col="coming"]');
    await ph.evaluate(`document.querySelector('[data-flow-card="${linaAppt}"]').scrollIntoView({ block: "center" })`);
    await ph.waitForTimeout(300);
    const lina0 = await appt(linaAppt);
    const lf = await centre(ph, `[data-flow-card="${linaAppt}"]`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: lf.x, y: lf.y }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: lf.x, y: lf.y - i * 20 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await ph.waitForTimeout(800);
    check(!(await appt(linaAppt)).arrived_at && !lina0.arrived_at, "a quick swipe on a card scrolls; it does not move the patient");
    // The late sheet is a phone's bottom sheet with big answers.
    await card(ph, linaAppt).locator("[data-flow-late]").click();
    await ph.locator("[data-late-sheet]").waitFor();
    await ph.waitForTimeout(600);
    const box = await ph.locator("[data-late-sheet] > div").last().boundingBox();
    const vh = ph.viewportSize()?.height ?? 0;
    check(!!box && Math.abs(box.y + box.height - vh) < 4, "on a phone Running late rises from the bottom", JSON.stringify(box));
    check(((await ph.locator('[data-late-minutes="15"]').boundingBox())?.height ?? 0) >= 40, "its minutes are big enough for a thumb");
    await phCtx.close();

    /* ============================================================ ready to bill */
    console.log("\n[ready to bill: minimised, one-tap remove, undo]");
    const [m1] = await q(
      `insert into chart_marks (clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status, fee, fee_manual, performed_by, recorded_by, done_at)
       values ($1, $2, '16', 'filling', 'Filling', 'حشوة', 'filling', 'procedure', 'done', 100, true, $3, $4, now()) returning id`,
      [clinic.id, lina, rana, deskUser]
    );
    const [m2] = await q(
      `insert into chart_marks (clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status, fee, fee_manual, performed_by, recorded_by, done_at)
       values ($1, $2, '26', 'filling', 'Filling', 'حشوة', 'filling', 'procedure', 'done', 50, true, $3, $4, now()) returning id`,
      [clinic.id, lina, rana, deskUser]
    );
    const fee = async (id: string) => (await q(`select fee::float as fee, fee_manual from chart_marks where id = $1`, [id]))[0];
    const bctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    // Next's dev-only badge sits over the bottom-left corner, where the viewer's tools are.
    await bctx.addInitScript(`addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "nextjs-portal{display:none!important}"; document.head.appendChild(s); });`);
    const bp = await bctx.newPage();
    watch(bp);
    await signIn(bp, `desk-${slug}@test.local`);
    await bp.goto(`${base}/invoices`);
    await bp.waitForSelector("[data-ready-desk][data-ready-open]", { timeout: 90_000 });
    check(
      (await bp.locator("[data-ready-desk]").getAttribute("data-ready-open")) === "0" && (await bp.locator("[data-desk-patient]").count()) === 0,
      "it opens minimised: one line above the invoices"
    );
    check((await bp.locator("[data-ready-toggle]").innerText()).includes("150"), "the line still says how much waits", await bp.locator("[data-ready-toggle]").innerText());
    await bp.click("[data-ready-toggle]");
    const row = bp.locator(`[data-desk-patient="${lina}"]`);
    await row.waitFor();
    check((await row.locator("[data-desk-lines]").count()) === 0, "each patient is one row until opened");
    await row.locator("[data-desk-expand]").click();
    await row.locator(`[data-desk-line="${m1.id}"]`).waitFor();
    await row.locator(`[data-desk-remove="${m1.id}"]`).click();
    check((await bp.getByRole("dialog").count()) === 0, "Remove asks nothing");
    check(await until(async () => (await row.locator(`[data-desk-line="${m1.id}"]`).count()) === 0), "the item leaves the list at once");
    check(await until(async () => (await fee(m1.id)).fee === 0), "and is set at no charge on the chart");
    await bp.locator("[data-toast-action]").first().click();
    check(await until(async () => (await row.locator(`[data-desk-line="${m1.id}"]`).count()) === 1), "Undo on the toast puts it back on the list");
    check(await until(async () => (await fee(m1.id)).fee === 100 && (await fee(m1.id)).fee_manual === true), "at exactly the price it had", JSON.stringify(await fee(m1.id)));
    await row.locator(`[data-desk-remove-all="${lina}"]`).click();
    check(await until(async () => (await bp.locator(`[data-desk-patient="${lina}"]`).count()) === 0), "Remove all takes the patient's whole list off");
    check(await until(async () => (await fee(m1.id)).fee === 0 && (await fee(m2.id)).fee === 0), "both items, at no charge");
    await bp.locator("[data-toast-action]").last().click();
    check(await until(async () => (await fee(m1.id)).fee === 100 && (await fee(m2.id)).fee === 50), "and Undo brings both back at their prices");
    await bp.reload();
    await bp.waitForSelector("[data-ready-desk][data-ready-open]", { timeout: 60_000 });
    check(await until(async () => (await bp.locator("[data-ready-desk]").getAttribute("data-ready-open")) === "1"), "opened once, it stays open on this computer");

    /* ============================================================ request from device: gone */
    console.log("\n[request from device is gone]");
    await bp.goto(`${base}/patients/${lina}?tab=files`);
    await bp.waitForSelector("[data-files-hub]", { timeout: 90_000 });
    check((await bp.locator("[data-request-device]").count()) === 0, "the Files tab has no Request from device");
    check((await bp.locator("[data-take-photo]").count()) === 1 && (await bp.locator("[data-patient-upload-folder]").count()) === 1, "Upload a folder and Take photo stay");

    /* ============================================================ pictures */
    console.log("\n[what a picture is, the tools, and Save]");
    const png = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .composite([{ input: await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 220, g: 220, b: 220 } } }).png().toBuffer(), left: 300, top: 100 }])
      .png()
      .toBuffer();
    await bp.selectOption("[data-files-hub] select", "view:panoramic");
    await bp.locator("[data-files-hub] input[type='file']:not([data-patient-folder-input])").setInputFiles({ name: "scan.png", mimeType: "image/png", buffer: png });
    check(await until(async () => (await q(`select 1 from patient_files where patient_id = $1`, [lina])).length === 1, 30_000), "uploaded");
    const [orig] = await q(`select id, kind, view, storage_path from patient_files where patient_id = $1`, [lina]);
    check(orig.kind === "xray" && orig.view === "panoramic", "uploaded as a Panoramic, it is filed as an x-ray of that view", JSON.stringify(orig));
    await bp.waitForSelector(`[data-file-tile="${orig.id}"] [data-file-label]`, { timeout: 30_000 });
    check((await bp.locator(`[data-file-tile="${orig.id}"] [data-file-label]`).innerText()).includes("Panoramic"), "its tile says Panoramic");
    await bp.locator(`[data-file-tile="${orig.id}"] button`).first().click();
    await bp.waitForSelector("[data-image-viewer]");
    check((await bp.locator("[data-viewer-what]").innerText()).includes("Panoramic"), "the viewer says what it is");
    check((await bp.locator("[data-views] [data-view]").count()) === 6, "and offers the six types beside the teeth: panoramic, bitewing, periapical, occlusal, CBCT, intraoral photo");
    await bp.click('[data-view="bitewing"]');
    check(await until(async () => (await q(`select view from patient_files where id = $1`, [orig.id]))[0].view === "bitewing"), "picking Bitewing saves it");
    check(await until(async () => (await bp.locator("[data-viewer-what]").innerText()).includes("Bitewing")), "and the viewer says so");

    // Adjust.
    await bp.click("[data-viewer-adjust]");
    await bp.waitForSelector("[data-adjust-panel]");
    await bp.waitForSelector("[data-viewer-canvas] canvas", { timeout: 20_000 });
    await bp.evaluate(`(() => {
      const el = document.querySelector('[data-adjust="sharp"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "60");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await bp.click("[data-adjust-invert]");
    check((await bp.locator("[data-viewer-save]").count()) === 1, "a change offers Save");
    check((await bp.locator("[data-compare]").count()) === 0, "and puts Compare away until it is saved");
    // The canvas really is inverted: the grey background (90) now reads light.
    const px = (await bp.evaluate(`(() => { const c = document.querySelector("[data-viewer-canvas] canvas"); return Array.from(c.getContext("2d").getImageData(5, 5, 1, 1).data); })()`)) as number[];
    check(px[0] > 140, "Invert inverts what is on the screen", JSON.stringify(px));
    await bp.click("[data-adjust-rotate]");
    check(await until(async () => (await bp.locator("[data-viewer-canvas] svg").getAttribute("viewBox")) === "0 0 400 800"), "Turn right stands the picture up");

    // Draw and measure.
    await bp.click("[data-viewer-draw]");
    await bp.waitForSelector("[data-draw-panel]");
    // Where a fraction of the picture is on the screen — measured each time, as the panel below it grows.
    const svgBox = async () => (await bp.locator("[data-viewer-canvas] svg").boundingBox())!;
    const at = async (fx: number, fy: number) => {
      const b = await svgBox();
      return { x: b.x + b.width * fx, y: b.y + b.height * fy };
    };
    const num = async (sel: string) => parseFloat(((await bp.locator(sel).first().textContent()) ?? "").replace(/[^0-9.]/g, ""));
    await bp.click('[data-tool="ruler"]');
    await bp.click("[data-draw-calibrate]");
    await mouseDrag(bp, await at(0.1, 0.1), await at(0.1, 0.6)); // 400 px of the picture's own
    await bp.locator("[data-calibrate-mm]").fill("20");
    await bp.locator("[data-calibrate-form] button[type='submit']").click();
    check(/1 px = 0\.0(49|50|51) mm/.test(await bp.locator("[data-draw-panel]").innerText()), "calibrated over a known length", await bp.locator("[data-draw-panel]").innerText());
    await mouseDrag(bp, await at(0.5, 0.1), await at(0.5, 0.35)); // 200 px
    check(
      await until(async () => Math.abs((await num('[data-mark="ruler"] text')) - 10) <= 0.3 && ((await bp.locator('[data-mark="ruler"] text').first().textContent()) ?? "").includes("mm")),
      "the ruler reads millimetres — 10 mm over half the calibrated length",
      String(await bp.locator('[data-mark="ruler"] text').first().textContent())
    );
    await bp.click('[data-tool="angle"]');
    await mouseDrag(bp, await at(0.2, 0.8), await at(0.5, 0.8));
    await mouseDrag(bp, await at(0.5, 0.5), await at(0.5, 0.5));
    check(
      await until(async () => Math.abs((await num('[data-mark="angle"] text')) - 90) <= 1.5),
      "the angle tool reads a right angle",
      String(await bp.locator('[data-mark="angle"] text').first().textContent())
    );
    await bp.click('[data-tool="pen"]');
    await mouseDrag(bp, await at(0.3, 0.3), await at(0.7, 0.45));
    await bp.click('[data-tool="text"]');
    await bp.fill("[data-draw-text]", "Caries");
    const tp = await at(0.6, 0.7);
    await bp.mouse.click(tp.x, tp.y);
    check((await bp.locator("[data-viewer-canvas] svg").getAttribute("data-viewer-marks")) === "4", "ruler, angle, brush and text are on the picture");
    await bp.click("[data-draw-undo]");
    check((await bp.locator("[data-viewer-canvas] svg").getAttribute("data-viewer-marks")) === "3", "Undo takes the last one off");
    await bp.click('[data-tool="erase"]');
    await bp.locator('[data-mark="pen"]').first().dispatchEvent("pointerdown");
    check(await until(async () => (await bp.locator("[data-viewer-canvas] svg").getAttribute("data-viewer-marks")) === "2"), "the eraser takes a mark off with a tap");

    // Save: a new picture beside the original.
    await bp.click("[data-viewer-save]");
    check(await until(async () => (await q(`select 1 from patient_files where patient_id = $1`, [lina])).length === 2, 30_000), "Save writes a new picture");
    const [copy] = await q(`select id, kind, view, mime_type, edited_from, storage_path from patient_files where patient_id = $1 and edited_from is not null`, [lina]);
    check(copy?.edited_from === orig.id && copy.kind === "xray" && copy.view === "bitewing" && copy.mime_type === "image/jpeg", "beside the original, as a bitewing x-ray, pointing back at it", JSON.stringify(copy));
    const [still] = await q(`select storage_path, view from patient_files where id = $1`, [orig.id]);
    check(still.storage_path === orig.storage_path, "the original is untouched");
    const res = await bp.request.get(`${base.replace("/c/", "/api/c/")}/files/${copy.id}`);
    const meta = await sharp(Buffer.from(await res.body())).metadata();
    check(meta.width === 400 && meta.height === 800, "the saved picture is the turned one, at full size", `${meta.width}x${meta.height}`);
    check(await until(async () => (await bp.locator("[data-viewer-save]").count()) === 0 && (await bp.locator("[data-send-patient]").count()) === 1), "the viewer moves on to the copy, ready to Send");
    await bp.keyboard.press("Escape");
    await bp.waitForSelector(`[data-file-tile="${copy.id}"] [data-file-edited]`, { timeout: 30_000 });
    check(true, "the copy's tile is marked edited");

    // Save & send.
    await bp.locator(`[data-file-tile="${orig.id}"] button`).first().click();
    await bp.waitForSelector("[data-image-viewer]");
    await bp.click("[data-viewer-draw]");
    await bp.waitForSelector("[data-viewer-canvas] svg", { timeout: 20_000 });
    const box2 = (await bp.locator("[data-viewer-canvas] svg").boundingBox())!;
    await bp.click('[data-tool="arrow"]');
    await mouseDrag(bp, { x: box2.x + box2.width * 0.2, y: box2.y + box2.height * 0.2 }, { x: box2.x + box2.width * 0.5, y: box2.y + box2.height * 0.5 });
    await bp.click("[data-viewer-save-send]");
    await bp.waitForSelector("[data-send-dialog]", { timeout: 30_000 });
    await bp.locator("[data-send-confirm]").click();
    check(await until(async () => (await sentTo("+962790771101")).some((m) => m.msg_type === "image"), 30_000), "Save & send sends the edited picture to the patient");
    check((await q(`select count(*)::int as n from patient_files where patient_id = $1`, [lina]))[0].n === 3, "as a third picture, the first two kept");
    await bctx.close();

    check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  } catch (e) {
    console.log("page errors so far:", errors.slice(0, 5).join(" | "));
    throw e;
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }
  console.log(`\n  late, drag, imaging: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e?.message ?? e);
  process.exit(1);
});
