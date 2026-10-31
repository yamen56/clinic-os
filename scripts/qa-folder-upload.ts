/**
 * A machine's folder, uploaded: the way in when the Bridge cannot be
 * installed and the folder cannot be watched. A panoramic machine's folder —
 * one subfolder per patient, JPEGs and a DICOM, plus the junk such folders
 * hold — goes up from the Devices page in one go; a CD of one patient's
 * x-rays goes up from that patient's Files.
 *
 * - The DICOM finds its patient by name and birth date, as a machine's would.
 * - The JPEGs are x-rays (the folder said so), never photos, and wait to be
 *   filed — a folder upload never answers the patient in the chair.
 * - The folder names the patient: suggested on the Devices page and in the
 *   patient's own Files; one tap files the whole folder when asked to.
 * - The same folder again sends nothing; Thumbs.db, DICOMDIR and a CD's
 *   viewer program are never sent.
 *
 * Run against a warm dev server (`npm run qa-warm` first).
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeDicom, uid } from "./lib-dicom-fixture";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "folder-upload");

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

async function signIn(browser: Browser, email: string, locale = "en"): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addCookies([{ name: "cos_locale", value: locale, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.waitForLoadState("networkidle");
  if (!new URL(page.url()).pathname.includes("login")) return page;
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qafold${tag}`;

  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features, timezone) values ('QA Pano','بانوراما',$1,'dental','{dental}','{"dental": true}','Asia/Amman') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const [owner] = await q(`insert into users (email, password_hash, full_name, locale) values ($1,$2,'Dr. Rakan','en') returning id`, [
    `fold-owner-${tag}@test.local`,
    hash,
  ]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}')`, [clinic.id, owner.id]);
  const patient = async (name: string, birth: string | null) =>
    (await q(`insert into patients (clinic_id, full_name, birth_date, source) values ($1,$2,$3,'staff') returning id`, [clinic.id, name, birth]))[0].id as string;
  const rakan = await patient("Rakan Ababneh", "1985-03-12");
  const omar = await patient("Omar Aziz", "1990-05-02");
  const sara = await patient("Sara Haddad", null);
  // Somebody in the chair, waiting on an x-ray: a folder of old pictures must not answer her.
  const [chair] = await q(`insert into imaging_requests (clinic_id, patient_id, kind, requested_by) values ($1,$2,'xray',$3) returning id`, [clinic.id, sara, owner.id]);
  const filesOf = (p: string) => q(`select file_name, kind, mime_type, dicom from patient_files where patient_id = $1 order by created_at`, [p]);

  /* The pano software's folder, as it would be on the clinic's PC. */
  const root = join(tmpdir(), `clinicti-qa-${tag}`);
  const pano = join(root, "Pano");
  mkdirSync(join(pano, "Ababneh Rakan"), { recursive: true });
  const jpeg = (shade: number) => sharp({ create: { width: 320, height: 160, channels: 3, background: { r: shade, g: shade, b: shade } } }).jpeg().toBuffer();
  writeFileSync(join(pano, "Ababneh Rakan", "PAN_20261027.jpg"), await jpeg(90));
  writeFileSync(join(pano, "Ababneh Rakan", "PAN_20261028.jpg"), await jpeg(120));
  writeFileSync(join(pano, "Ababneh Rakan", "Thumbs.db"), Buffer.from("not an x-ray"));
  const omarDicom = makeDicom({ sopUid: uid(), seriesUid: uid(), studyUid: uid(), patientId: "VND-77", patientName: "Aziz^Omar", birthDate: "19900502", description: "Panoramic" });
  writeFileSync(join(pano, "IM0001"), omarDicom);
  writeFileSync(join(pano, "desktop.ini"), Buffer.from("[.ShellClassInfo]"));
  // A CD of Sara's: three slices of one series, beside the viewer the machine burns with it.
  const cd = join(root, "CD");
  mkdirSync(join(cd, "DICOM"), { recursive: true });
  const series = uid();
  const study = uid();
  for (let i = 1; i <= 3; i++) {
    writeFileSync(
      join(cd, "DICOM", `IM000${i}`),
      makeDicom({ sopUid: uid(), seriesUid: series, studyUid: study, patientId: "VND-9", patientName: "Haddad^Sara", instanceNumber: i, modality: "CT" })
    );
  }
  writeFileSync(join(cd, "viewer.exe"), Buffer.from("MZ not a picture"));
  writeFileSync(join(cd, "autorun.inf"), Buffer.from("[autorun]"));

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const page = await signIn(browser, `fold-owner-${tag}@test.local`);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/.test(m.text()) && errors.push(`[console] ${m.text().slice(0, process.env.QA_FULL ? 20000 : 300)}`));

    console.log("\nuploading the machine's folder");
    await page.goto(`${BASE}/c/${slug}/devices`, { timeout: 180000 });
    await page.waitForSelector("[data-upload-folder]", { timeout: 120000 });
    const card = await page.locator("[data-folder-card]").innerText();
    check(card.includes("Upload a folder") && card.includes("Watch a folder"), "the Devices page offers Upload a folder beside Watch a folder", card);
    check((await page.locator("[data-folder-kind]").inputValue()) === "xray", "and in a dental clinic its pictures are x-rays unless somebody says otherwise");
    await page.locator("[data-folder-input]").setInputFiles(pano);
    await page.waitForSelector("[data-bulk-done]", { timeout: 120000 });
    const done = await page.locator("[data-bulk-done]").getAttribute("data-bulk-done");
    check(done === "1/2/0/0", "three results go up: one to its patient, two to be filed; Thumbs.db and desktop.ini are not sent", done ?? "");
    const doneText = await page.locator("[data-bulk-done]").innerText();
    check(doneText.includes("Pano is uploaded") && doneText.includes("1 went to their patients' Files") && doneText.includes("2 wait to be filed below"), "and says so", doneText);
    await page.screenshot({ path: join(SHOTS, "1-uploaded.png"), fullPage: true });

    const omarFiles = await filesOf(omar);
    check(omarFiles.length === 1 && omarFiles[0].kind === "xray" && omarFiles[0].dicom, "the DICOM found Omar by the name and birth date inside it, as an x-ray", JSON.stringify(omarFiles.map((f) => [f.file_name, f.kind])));
    const inbox = await q(`select kind, hint from imaging_inbox where clinic_id = $1 and assigned_at is null order by received_at`, [clinic.id]);
    check(inbox.length === 2 && inbox.every((i) => i.kind === "xray"), "the JPEGs wait as x-rays, not photos", JSON.stringify(inbox.map((i) => i.kind)));
    check(inbox.every((i) => i.hint?.folder === "Ababneh Rakan"), "each remembers the folder it sat in", JSON.stringify(inbox.map((i) => i.hint)));
    const [chairNow] = await q(`select fulfilled_at from imaging_requests where id = $1`, [chair.id]);
    check(!chairNow.fulfilled_at && (await filesOf(sara)).length === 0, "the patient in the chair was not handed somebody's old x-ray");

    console.log("\nfiling what waits");
    await page.waitForSelector("[data-inbox-item]", { timeout: 30000 });
    const row = page.locator("[data-inbox-item]").first();
    const rowText = await row.innerText();
    check(rowText.includes("Folder: Ababneh Rakan"), "the inbox shows the folder", rowText);
    check(await row.locator(`[data-suggestion='${rakan}']`).count(), "and suggests Rakan Ababneh from it");
    check(!(await row.locator(`[data-suggestion='${omar}']`).count()), "and nobody the folder does not name");
    check((await row.locator("[data-inbox-together]").innerText()).includes("Also file the other 1 from “Ababneh Rakan”"), "it offers the rest of the folder too");
    await row.locator("[data-inbox-together] input").check();
    await row.locator(`[data-suggestion='${rakan}']`).click();
    await page.waitForFunction(() => !document.querySelector("[data-inbox-item]"), null, { timeout: 30000 });
    const rakanFiles = await filesOf(rakan);
    check(rakanFiles.length === 2 && rakanFiles.every((f) => f.kind === "xray"), "one tap filed both of Rakan's x-rays", JSON.stringify(rakanFiles.map((f) => [f.file_name, f.kind])));

    console.log("\nthe same folder again");
    await page.locator("[data-folder-input]").setInputFiles(pano);
    await page.waitForFunction(() => document.querySelector("[data-bulk-done]")?.getAttribute("data-bulk-done") === "0/0/3/0", null, { timeout: 60000 }).catch(() => null);
    const again = await page.locator("[data-bulk-done]").innerText();
    check(again.includes("Nothing new in Pano"), "sends nothing: everything was sent before", again);
    check((await q(`select count(*)::int as n from imaging_inbox where clinic_id = $1`, [clinic.id]))[0].n === 2, "and makes no second copies");

    console.log("\nthe folder names the patient on their own file");
    mkdirSync(join(root, "Later", "Omar Aziz"), { recursive: true });
    writeFileSync(join(root, "Later", "Omar Aziz", "PAN_20261029.jpg"), await jpeg(150));
    await page.locator("[data-folder-input]").setInputFiles(join(root, "Later"));
    await page.waitForFunction(() => document.querySelector("[data-bulk-done]")?.getAttribute("data-bulk-done") === "0/1/0/0", null, { timeout: 60000 });
    await page.goto(`${BASE}/c/${slug}/patients/${omar}?tab=files`, { timeout: 180000 });
    await page.waitForSelector("[data-files-hub]", { timeout: 120000 });
    const likely = page.locator("[data-likely]");
    check((await likely.count()) === 1 && (await likely.innerText()).includes("Folder: Omar Aziz"), "Omar's Files shows the x-ray from his folder as probably his", (await likely.count()) ? await likely.innerText() : "none");

    console.log("\na CD into one patient's Files");
    await page.goto(`${BASE}/c/${slug}/patients/${sara}?tab=files`, { timeout: 180000 });
    await page.waitForSelector("[data-patient-upload-folder]", { timeout: 120000 });
    check((await page.locator("[data-patient-upload-folder]").innerText()).includes("Upload a folder"), "a patient's Files has Upload a folder");
    await page.locator("[data-patient-folder-input]").setInputFiles(cd);
    await page.waitForSelector("[data-file-tile]", { timeout: 120000 });
    // The slices go up one after another; the first makes the tile, the rest join it.
    for (let i = 0; i < 60; i++) {
      const f = await filesOf(sara);
      if (f.length === 1 && f[0].dicom?.instances?.length === 3) break;
      await page.waitForTimeout(1000);
    }
    const saraFiles = await filesOf(sara);
    check(
      saraFiles.length === 1 && saraFiles[0].dicom?.instances?.length === 3,
      "the three slices are one scan in Sara's Files, and the viewer program and autorun are left on the CD",
      JSON.stringify(saraFiles.map((f) => [f.file_name, f.mime_type, f.dicom?.instances?.length]))
    );
    await page.screenshot({ path: join(SHOTS, "2-patient-cd.png"), fullPage: true });

    console.log("\nthe machine's next picture finds its patient by itself");
    // Nobody in the chair from here on: what follows is the machine's own name for each patient.
    await q(`update imaging_requests set cancelled_at = now() where id = $1`, [chair.id]);
    const links = (p: string) => q(`select id, key, label from imaging_patient_links where patient_id = $1 order by created_at`, [p]);
    const rakanLinks = await links(rakan);
    check(rakanLinks.length === 1 && rakanLinks[0].key === "folder:ababneh rakan", "filing Rakan's folder once taught Clinicti what the machine calls him", JSON.stringify(rakanLinks));
    check(!(await q(`select 1 from imaging_patient_links where clinic_id = $1 and key like 'folder:pano%'`, [clinic.id])).length, "and the folder the upload started from taught nothing");
    /** One picture, as the watched folder sends it the moment the machine saves it. */
    const live = async (name: string, data: Buffer, folder: string | null, mimeType = "image/jpeg") => {
      const res = await page.request.post(`${BASE}/api/c/${slug}/imaging/receive`, {
        multipart: { file: { name, mimeType, buffer: data }, kind: "xray", ...(folder ? { folder } : {}) },
      });
      return (await res.json()) as { placed?: string; patientId?: string; inboxId?: string };
    };
    let r = await live("PAN_20261031.jpg", await jpeg(160), "Ababneh Rakan");
    check(r.placed === "patient" && r.patientId === rakan, "a new x-ray saved in his folder goes straight to Rakan", JSON.stringify(r));
    mkdirSync(join(root, "Next", "Ababneh Rakan"), { recursive: true });
    writeFileSync(join(root, "Next", "Ababneh Rakan", "PAN_20261101.jpg"), await jpeg(170));
    await page.goto(`${BASE}/c/${slug}/devices`, { timeout: 180000 });
    await page.locator("[data-folder-input]").setInputFiles(join(root, "Next"));
    await page.waitForFunction(() => document.querySelector("[data-bulk-done]")?.getAttribute("data-bulk-done") === "1/0/0/0", null, { timeout: 60000 }).catch(() => null);
    check((await page.locator("[data-bulk-done]").getAttribute("data-bulk-done")) === "1/0/0/0", "and so does one in an uploaded folder", (await page.locator("[data-bulk-done]").getAttribute("data-bulk-done")) ?? "");
    check((await filesOf(rakan)).length === 4, "Rakan's Files now hold all four");

    const [{ file_no: saraNo }] = await q(`select file_no from patients where id = $1`, [sara]);
    r = await live(`CLN-${saraNo}_PAN.jpg`, await jpeg(60), "Today");
    check(r.placed === "patient" && r.patientId === sara, "a picture the machine saved under Sara's Clinicti number goes to Sara", JSON.stringify(r));

    const vendor = (name: string) =>
      makeDicom({ sopUid: uid(), seriesUid: uid(), studyUid: uid(), patientId: "VND-500", patientName: name, description: "Panoramic" });
    r = await live("IM0100", vendor("Haddad^Sara"), null, "application/dicom");
    check(r.placed === "inbox", "the machine's own ID for Sara, never seen before, waits to be filed", JSON.stringify(r));
    const filedVendor = await page.request.post(`${BASE}/api/c/${slug}/imaging/inbox/${r.inboxId}`, { data: { op: "file", patientId: sara } });
    const filedBody = (await filedVendor.json()) as { learned?: string[] };
    check(filedBody.learned?.includes("VND-500"), "filing it once teaches the machine's ID", JSON.stringify(filedBody));
    r = await live("IM0101", vendor("Haddad^Sara"), null, "application/dicom");
    check(r.placed === "patient" && r.patientId === sara, "the machine's next x-ray under that ID goes to Sara by itself", JSON.stringify(r));
    r = await live("IM0102", vendor("Aziz^Omar"), null, "application/dicom");
    check(r.placed === "inbox", "but not one the machine says belongs to somebody else under the same ID", JSON.stringify(r));

    console.log("\nthe patient's file shows it");
    await page.goto(`${BASE}/c/${slug}/patients/${omar}?tab=files`, { timeout: 180000 });
    await page.waitForSelector("[data-likely-file]", { timeout: 120000 });
    check((await page.locator("[data-machine-id]").getAttribute("data-machine-id")) === "CLN-2", "Omar's Files gives his number for the machine: CLN-2");
    check((await page.locator("[data-machine-id]").innerText()).includes("every picture of them comes here by itself"), "and says what it is for");
    // The one from his folder — the DICOM that names him under Sara's machine ID waits here too.
    await page.locator("[data-likely]", { hasText: "Folder: Omar Aziz" }).locator("[data-likely-file]").click();
    await page.waitForSelector("[data-machine-links]", { timeout: 30000 });
    check((await page.locator("[data-machine-links]").innerText()).includes("Omar Aziz"), "filing the picture from his folder here teaches it too, and shows it", await page.locator("[data-machine-links]").innerText());
    await page.screenshot({ path: join(SHOTS, "5-machine-id.png"), fullPage: true });

    await page.goto(`${BASE}/c/${slug}/patients/${rakan}?tab=files`, { timeout: 180000 });
    await page.waitForSelector("[data-forget-link]", { timeout: 120000 });
    // The chip goes at once; the server's answer is what counts.
    const forgotten = page.waitForResponse((res) => res.url().includes("/imaging/links/") && res.request().method() === "DELETE", { timeout: 60000 });
    await page.locator("[data-forget-link]").first().click();
    check((await forgotten).ok() && !(await page.locator("[data-forget-link]").count()), "the link goes from Rakan's file at a tap");
    check((await links(rakan)).length === 0, "forgetting the link on Rakan's file forgets it");
    r = await live("PAN_20261102.jpg", await jpeg(180), "Ababneh Rakan");
    check(r.placed === "inbox", "and his folder's next picture waits to be filed again", JSON.stringify(r));
    await page.request.post(`${BASE}/api/c/${slug}/imaging/inbox/${r.inboxId}`, { data: { op: "file", patientId: rakan } });
    check((await links(rakan)).length === 1, "until it is filed to him once more");
    await patient("Rakan Ababneh Hadi", null);
    r = await live("PAN_20261103.jpg", await jpeg(190), "Ababneh Rakan");
    check(r.placed === "inbox", "a second Rakan Ababneh registered since makes the folder a question again, not a guess", JSON.stringify(r));

    console.log("\nconnect a machine starts with the way that needs no setup");
    await page.goto(`${BASE}/c/${slug}/settings/devices`, { timeout: 180000 });
    await page.waitForSelector("[data-connect-machine]", { timeout: 120000 });
    await page.click("[data-connect-machine]");
    const upload = page.locator("[data-choice='upload']");
    await upload.waitFor({ timeout: 30000 });
    const uploadText = await upload.innerText();
    check(uploadText.includes("Simplest: upload the machine's folder") && uploadText.includes("no network or IP settings"), "before the Bridge and the network: upload the folder, nothing to install", uploadText);
    await page.screenshot({ path: join(SHOTS, "4-connect.png") });
    await upload.click();
    await page.waitForURL((u) => u.pathname === `/c/${slug}/devices`, { timeout: 60000 });
    check(true, "and it opens the Devices page, where the folder goes up");

    console.log("\nin Arabic");
    // Sign-in applies the user's own language over the cookie.
    await q(`update users set locale = 'ar' where id = $1`, [owner.id]);
    const ar = await signIn(browser, `fold-owner-${tag}@test.local`, "ar");
    await ar.goto(`${BASE}/c/${slug}/devices`, { timeout: 180000 });
    await ar.waitForSelector("[data-folder-card]", { timeout: 120000 });
    const arCard = await ar.locator("[data-folder-card]").innerText();
    check(arCard.includes("رفع مجلد") && arCard.includes("مجلد الجهاز"), "the folder card reads in Arabic", arCard);
    await ar.screenshot({ path: join(SHOTS, "3-arabic.png"), fullPage: true });
    await ar.context().close();

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]);
    await q(`delete from users where email like $1`, [`fold-%-${tag}@test.local`]);
    await db.end();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
