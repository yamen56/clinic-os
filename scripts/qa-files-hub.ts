/**
 * The patient's Files as the hub for every kind of clinic, not only dental:
 * a cardiology clinic's ECG cart, echo machine and camera send into the
 * patient's file; "Request from device" asks one machine and is answered by
 * that machine only; a result that looks like this patient's can be filed from
 * the file in one tap; the Devices page and its nav entry; and the agency's
 * specialty switch turning the dental module on and off.
 *
 * Run against a warm dev server (`npm run qa-warm` first).
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeDicom, uid } from "./lib-dicom-fixture";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "files-hub");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

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

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
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

/** A machine's upload: its key, no cookie. */
async function send(key: string, data: Buffer, name: string) {
  const fd = new FormData();
  fd.set("file", new Blob([new Uint8Array(data)]), name);
  const res = await fetch(`${BASE}/api/devices/v1/images`, { method: "POST", body: fd, headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}
async function waitingFor(key: string) {
  const res = await fetch(`${BASE}/api/devices/v1/requests`, { headers: { authorization: `Bearer ${key}` } });
  return ((await res.json()) as { requests: { id: string; note: string; kind: string }[] }).requests;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qaheart${tag}`;

  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features, timezone)
     values ('QA Heart','القلب',$1,'cardiology','{cardiology}','{}','Asia/Amman') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const user = async (email: string, name: string, locale = "en", admin = false) =>
    (
      await q(
        `insert into users (email, password_hash, full_name, locale, is_super_admin, admin_permissions) values ($1,$2,$3,$4,$5,$6) returning id`,
        [email, hash, name, locale, admin, admin ? '{"level":"full"}' : "{}"]
      )
    )[0].id as string;
  const ownerUser = await user(`hub-owner-${tag}@test.local`, "Dr. Samer Haddad");
  const arUser = await user(`hub-ar-${tag}@test.local`, "د. ليلى", "ar");
  const adminUser = await user(`hub-admin-${tag}@test.local`, "QA Admin", "en", true);
  for (const u of [ownerUser, arUser]) {
    await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',$3,'{"level":"full"}')`, [clinic.id, u, u === ownerUser]);
  }
  const [patient] = await q(
    `insert into patients (clinic_id, full_name, birth_date, phone_e164, source) values ($1,'Rami Khatib','1988-03-14','+962790000777','staff') returning id`,
    [clinic.id]
  );
  const filesOf = () => q(`select id, kind, mime_type, device_id from patient_files where patient_id = $1 order by created_at`, [patient.id]);
  const fileUrl = `${BASE}/c/${slug}/patients/${patient.id}?tab=files`;
  const navDevices = (p: Page) => p.locator(`a[href='/c/${slug}/devices']`);

  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const errors: string[] = [];
  try {
    const page = await signIn(browser, `hub-owner-${tag}@test.local`);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/.test(m.text()) && errors.push(`[console] ${m.text().slice(0, 300)}`));

    /* ── Before any machine ──────────────────────────────────────────── */
    console.log("\na clinic with no machines");
    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-files-hub]", { timeout: 120000 });
    await page.waitForLoadState("networkidle");
    check((await navDevices(page).count()) === 0, "the nav carries no empty Devices page");
    await page.click("[data-request-device]");
    await page.locator("[data-request-none]").waitFor({ timeout: 10000 });
    check(
      (await page.locator(`[data-request-none] a[href='/c/${slug}/settings/devices']`).count()) === 1,
      "Request from device, with no machine yet, says so and offers the owner the setup"
    );
    await page.keyboard.press("Escape");

    /* ── The machines a cardiology clinic connects ───────────────────── */
    console.log("\nconnecting an ECG cart, an echo machine and a camera");
    const make = async (name: string, kind: string) => {
      const r = await page.request.post(`${BASE}/api/c/${slug}/devices`, { data: { name, kind } });
      const b = await r.json();
      return { id: b.device?.id as string, key: b.key as string };
    };
    const ecg = await make("ECG cart", "ecg");
    const echo = await make("Echo room", "ultrasound");
    const cam = await make("Exam camera", "camera");
    check(ecg.key && echo.key && cam.key, "the new machine types are accepted (ECG, ultrasound)");

    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-files-hub]", { timeout: 60000 });
    await page.waitForLoadState("networkidle");
    check((await navDevices(page).count()) > 0, "with a machine connected, Devices joins the nav");

    /* ── Request from device: one machine, with what is wanted ───────── */
    console.log("\nrequest from device");
    await page.click("[data-request-device]");
    await page.locator(`[data-request-option='${ecg.id}']`).click();
    await page.locator("[data-request-note]").fill("12-lead");
    await page.screenshot({ path: join(SHOTS, "request-from-device.png") });
    await page.click("[data-request-go]");
    const waitingRow = page.locator("[data-waiting-request]");
    await waitingRow.waitFor({ timeout: 10000 });
    const rowText = await waitingRow.innerText();
    check(rowText.includes("ECG cart") && rowText.includes("12-lead"), "the file shows it waiting on the ECG cart, with the note", rowText);
    const [req] = await q(`select id, kind, device_id, note from imaging_requests where patient_id = $1 and fulfilled_at is null`, [patient.id]);
    check(req?.kind === "file" && req.device_id === ecg.id && req.note === "12-lead", "saved as a request of that machine", JSON.stringify(req));
    check((await waitingFor(ecg.key)).some((r) => r.id === req.id && r.note === "12-lead"), "the ECG cart's Bridge sees it, note and all");
    check(!(await waitingFor(cam.key)).some((r) => r.id === req.id), "the camera's Bridge does not");

    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer();
    const stray = await send(cam.key, png, "IMG_2001.png");
    check(stray.json?.placed === "inbox", "a picture from the camera does not answer the ECG cart's request", JSON.stringify(stray.json));
    const answer = await send(ecg.key, PDF, "ECG_0001.pdf");
    check(answer.json?.placed === "patient" && answer.json?.requestId === req.id, "the ECG cart's PDF answers it", JSON.stringify(answer.json));
    await waitingRow.waitFor({ state: "detached", timeout: 20000 });
    await page.locator("[data-file-kind='ecg']").first().waitFor({ timeout: 20000 });
    check(true, "the ECG appears in the file by itself, marked ECG");
    const kept = await filesOf();
    check(kept.some((f) => f.kind === "ecg" && f.mime_type === "application/pdf" && f.device_id === ecg.id), "kept as an ECG from that machine", JSON.stringify(kept));

    /* ── A result that looks like this patient's ─────────────────────── */
    console.log("\nfiled from the patient's file");
    const echoDcm = makeDicom({ sopUid: uid(), seriesUid: uid(), studyUid: uid(), patientId: "US-77", patientName: "KHATEEB^RAMI", birthDate: "19880314", modality: "US", description: "Echo" });
    const echoed = await send(echo.key, echoDcm, "US0001.dcm");
    check(echoed.json?.placed === "inbox", "an echo whose name is spelled differently is not guessed", JSON.stringify(echoed.json));
    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-files-hub]", { timeout: 60000 });
    await page.waitForLoadState("networkidle");
    const likely = page.locator("[data-likely]");
    check((await likely.count()) === 1, "the file offers it as probably theirs (same birth date) — and not the camera's nameless picture", String(await likely.count()));
    await page.screenshot({ path: join(SHOTS, "likely.png"), fullPage: true });
    await page.locator("[data-likely-file]").click();
    await page.locator("[data-file-kind='ultrasound']").first().waitFor({ timeout: 20000 });
    check((await likely.count()) === 0, "one tap files it here, as an ultrasound");

    /* ── The gallery, its filters, one viewer ────────────────────────── */
    console.log("\nthe gallery");
    const chips = await page.locator("[data-files-filter]").evaluateAll((els) => els.map((e) => e.getAttribute("data-files-filter")));
    check(chips.join() === "all,ecg,ultrasound", "filters in the order a cardiology clinic reads: ECG, then ultrasound", chips.join());
    await page.click("[data-files-filter='ecg']");
    check(
      (await page.locator("[data-file-tile]").count()) === 1 && (await page.locator("[data-file-kind='ecg']").count()) === 1,
      "the ECG filter shows only the ECG"
    );
    await page.click("[data-files-filter='all']");
    await page.locator("[data-file-kind='ultrasound'] button").first().click();
    const viewer = page.locator("[data-image-viewer]");
    await viewer.waitFor({ timeout: 10000 });
    check(await page.locator("[data-pins]").evaluate((el) => el.classList.contains("hidden")), "the viewer opens the echo, with no teeth to pin in a heart clinic");
    check((await page.locator("[data-send-patient]").count()) === 1, "and offers to send it to the patient");
    await page.locator("[data-send-patient]").click();
    const caption = await page.locator("[data-send-dialog] textarea").inputValue();
    check(caption.startsWith("From QA Heart") && !/x-ray/i.test(caption), "its message does not call an echo an x-ray", caption);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached", timeout: 5000 });

    /* ── Take photo, from this computer's camera ─────────────────────── */
    console.log("\ntake photo");
    await page.click("[data-take-photo]");
    await page.locator("[data-camera]").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Capture" }).click({ timeout: 15000 });
    await page.getByRole("button", { name: "Save photo" }).click({ timeout: 10000 });
    await page.locator("[data-file-kind='photo']").first().waitFor({ timeout: 20000 });
    check((await filesOf()).filter((f) => f.kind === "photo").length === 1, "a photo taken in the file is saved as a photo");
    await page.screenshot({ path: join(SHOTS, "files-hub.png"), fullPage: true });

    /* ── The Devices page ────────────────────────────────────────────── */
    console.log("\nthe Devices page");
    await page.request.post(`${BASE}/api/c/${slug}/imaging/requests`, { data: { patientId: patient.id, kind: "file", deviceId: ecg.id, note: "rhythm strip" } });
    await page.goto(`${BASE}/c/${slug}/imaging`, { timeout: 120000 });
    await page.waitForURL((u) => u.pathname === `/c/${slug}/devices`, { timeout: 30000 });
    check(true, "the old Imaging address lands on Devices");
    await page.waitForSelector("[data-imaging-station]", { timeout: 60000 });
    const meta = await page.locator("[data-request-meta]").first().innerText();
    check(meta.includes("ECG cart") && meta.includes("rhythm strip"), "who is waiting, on which machine, for what", meta);
    await page.locator("[data-inbox-item]").first().waitFor({ timeout: 30000 });
    check((await page.locator("[data-inbox-item]").count()) === 1, "the camera's nameless picture waits to be filed");
    check((await navDevices(page).first().innerText()).includes("1"), "and the nav's Devices entry counts it");
    await page.screenshot({ path: join(SHOTS, "devices-page.png"), fullPage: true });

    const ar = await signIn(browser, `hub-ar-${tag}@test.local`);
    ar.on("pageerror", (e) => errors.push(`[ar] ${e.message}`));
    ar.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/.test(m.text()) && errors.push(`[ar console] ${m.text().slice(0, 300)}`));
    await ar.goto(`${BASE}/c/${slug}/devices`, { timeout: 120000 });
    await ar.waitForSelector("[data-imaging-station] [data-inbox-item]", { timeout: 60000 });
    const arText = await ar.locator("main").innerText();
    check(arText.includes("الأجهزة") && arText.includes("بانتظار وضعها في ملف"), "the page speaks the doctor's Arabic");
    await ar.locator("[data-request-meta]").first().waitFor({ timeout: 30000 });
    check((await ar.locator("[data-request-meta]").first().innerText()).includes("rhythm strip"), "and shows her the same waiting request");
    await ar.screenshot({ path: join(SHOTS, "devices-page-ar.png"), fullPage: true });
    await ar.context().close();

    /* ── Settings → Devices, for this specialty ──────────────────────── */
    await page.goto(`${BASE}/c/${slug}/settings/devices`, { timeout: 120000 });
    await page.waitForSelector("[data-connect-machine]", { timeout: 60000 });
    await page.click("[data-advanced]");
    await page.click("[data-add-device]");
    check((await page.locator("[data-device-kind]").inputValue()) === "ecg", "a new machine starts as an ECG here");
    const kinds = await page.locator("[data-device-kind] option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    check(kinds.slice(0, 3).join() === "ecg,ultrasound,monitor", "a cardiology clinic's machine list starts with its own machines", kinds.slice(0, 4).join());
    await page.context().close();

    /* ── The agency: a specialty brings its modules ──────────────────── */
    console.log("\nthe specialty decides");
    const admin = await signIn(browser, `hub-admin-${tag}@test.local`);
    admin.on("pageerror", (e) => errors.push(`[admin] ${e.message}`));
    await admin.goto(`${BASE}/admin/clinics/new`, { timeout: 120000 });
    const spec = admin.locator("select[name='specialty']");
    await spec.waitFor({ timeout: 60000 });
    await spec.selectOption("cardiology");
    const adds = admin.locator("[data-specialty-adds]");
    check(/ECG/.test(await adds.innerText()) && (await admin.locator("[data-adds-modules]").count()) === 0, "a cardiology clinic is told what it gets: ECG machines and results, no dental chart");
    await spec.selectOption("dental");
    check((await admin.locator("[data-adds-modules]").innerText()).includes("Dental chart"), "a dental clinic gets the dental chart");

    await admin.goto(`${BASE}/admin/clinics/${slug}`, { timeout: 120000 });
    const setSpecialty = async (s: string) => {
      await admin.getByRole("button", { name: "Specialty" }).first().click();
      const dialog = admin.getByRole("dialog");
      await dialog.locator("select").first().selectOption(s);
      await dialog.getByRole("button", { name: "Install its recipes" }).click();
      await dialog.waitFor({ state: "detached", timeout: 60000 });
      return (await q(`select specialty, coalesce(features->>'dental','') as dental from clinics where id = $1`, [clinic.id]))[0];
    };
    await admin.getByRole("button", { name: "Specialty" }).first().waitFor({ timeout: 60000 });
    const toDental = await setSpecialty("dental");
    check(toDental.specialty === "dental" && toDental.dental === "true", "switching the clinic to Dental switches the dental chart on", JSON.stringify(toDental));
    const back = await setSpecialty("cardiology");
    check(back.specialty === "cardiology" && back.dental === "false", "and back to Cardiology switches it off again", JSON.stringify(back));
    await admin.context().close();

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]);
    await q(`delete from users where email like $1`, [`hub-%-${tag}@test.local`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
