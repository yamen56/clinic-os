/**
 * The clinic's machines, connected: a registered device sends images over
 * HTTPS (or DICOM through a STOW-RS relay), and each lands in the right
 * patient's Files — by the doctor's "Take x-ray", by the file number the
 * machine was given, or in the imaging inbox for a person to file. Never in a
 * stranger's file, never in another clinic.
 *
 * Fixtures: two clinics, an owner-doctor and a receptionist in the first, a
 * patient in each. Run against a warm dev server (`npm run qa-warm` first).
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeDicom, stowBody, uid } from "./lib-dicom-fixture";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "devices");
const STORAGE = resolve(process.cwd(), process.env.STORAGE_DIR || "./storage");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
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

/** A device's call: key in the header, no cookie. */
async function dev(key: string | null, path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE}/api/devices/v1${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json: json as Record<string, any> | null, headers: res.headers };
}
function upload(key: string, data: Buffer, name: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new Blob([new Uint8Array(data)]), name);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return dev(key, "/images", { method: "POST", body: fd });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qadev${tag}`;

  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features, timezone) values ('QA Imaging','تصوير',$1,'dental','{dental}','{"dental": true}','Asia/Amman') returning id`,
    [slug]
  );
  const [other] = await q(`insert into clinics (name, name_ar, slug, specialty) values ('QA Elsewhere','أخرى',$1,'dental') returning id`, [`qadevb${tag}`]);
  for (const c of [clinic, other]) await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [c.id]);
  const user = async (email: string, name: string) =>
    (await q(`insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'en') returning id`, [email, hash, name]))[0].id as string;
  const ownerUser = await user(`dev-owner-${tag}@test.local`, "Dr. Hala Saeed");
  const deskUser = await user(`dev-desk-${tag}@test.local`, "Desk Noor");
  const [ownerMember] = await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}') returning id`,
    [clinic.id, ownerUser]
  );
  await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',false,'{"level":"custom","caps":{"dashboard":true,"patients":true,"settings":true,"settings.clinic":false}}')`,
    [clinic.id, deskUser]
  );
  const [rana] = await q(
    `insert into patients (clinic_id, full_name, birth_date, gender, phone_e164, source) values ($1,'Rana Haddad','1990-05-02','female','+962790000101','staff') returning id, file_no`,
    [clinic.id]
  );
  const [omar] = await q(`insert into patients (clinic_id, full_name, source) values ($1,'Omar Aziz','staff') returning id, file_no`, [clinic.id]);
  const [zaid] = await q(`insert into patients (clinic_id, full_name, source) values ($1,'Zaid Elsewhere','staff') returning id, file_no`, [other.id]);
  await q(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
     values ($1,$2,$3, now() + interval '1 hour', now() + interval '90 minutes', 'confirmed')`,
    [clinic.id, rana.id, ownerMember.id]
  );
  const filesOf = (patientId: string) =>
    q(`select id, file_name, mime_type, kind, teeth, device_id, dicom, storage_path, uploaded_by from patient_files where patient_id = $1 order by created_at`, [patientId]);

  console.log("\nfile numbers");
  check(rana.file_no === 1 && omar.file_no === 2, "a clinic's patients are numbered 1, 2, … as they are registered", `${rana.file_no}, ${omar.file_no}`);
  check(zaid.file_no === 1, "and another clinic counts from 1 on its own");

  const browser = await chromium.launch();
  const errors: string[] = [];
  let key = "";
  let deviceId = "";
  try {
    /* ── The owner registers the OPG ─────────────────────────────────── */
    console.log("\nregistering a device");
    const page = await signIn(browser, `dev-owner-${tag}@test.local`);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/c/${slug}/settings/devices`, { timeout: 120000 });
    await page.waitForSelector("[data-connect-machine]", { timeout: 120000 });
    check(await page.locator(`nav a[href='/c/${slug}/settings/devices']`).count(), "Settings has a Devices tab for the owner");
    // The API-key route is the engineer's, folded under "For IT".
    await page.click("[data-advanced]");
    await page.click("[data-add-device]");
    await page.fill("[data-device-name]", "OPG room 2");
    await page.selectOption("[data-device-kind]", "opg");
    await page.click("[data-save-device]");
    const keyBox = page.locator("[data-device-key]");
    await keyBox.waitFor({ timeout: 20000 });
    key = (await keyBox.getAttribute("data-device-key")) ?? "";
    check(/^ctd_[\w-]{40,}$/.test(key), "creating it shows its key, once");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: /DICOM/ }).click();
    const snippet = await dialog.locator("[data-device-setup] pre").first().innerText();
    check(snippet.includes(key) && snippet.includes("/api/devices/v1/dicomweb/"), "the DICOM setup carries the key and the address to send to");
    await page.screenshot({ path: join(SHOTS, "key.png") });
    await page.click("[data-key-done]");
    const [row] = await q(`select id, key_hash, match_by from clinic_devices where clinic_id = $1`, [clinic.id]);
    deviceId = row.id;
    check(row && row.key_hash !== key && row.key_hash.length === 64 && row.match_by === "none", "only the key's hash is stored, and the machine's own IDs are not trusted by default");

    /* ── Whose key is it ─────────────────────────────────────────────── */
    console.log("\nthe device's key");
    const none = await dev(null, "/me");
    check(none.status === 401 && /Basic/.test(none.headers.get("www-authenticate") ?? ""), "no key: 401, with a challenge a relay understands");
    check((await dev("ctd_madeup-but-plausible-0000000000000000000000000", "/me")).status === 401, "a made-up key: 401");
    const me = await dev(key, "/me");
    check(me.status === 200 && me.json?.device?.name === "OPG room 2" && me.json?.clinic?.name === "QA Imaging", "the key answers with its device and its clinic");
    const basic = await dev(null, "/me", { headers: { authorization: `Basic ${Buffer.from(`clinicti:${key}`).toString("base64")}` } });
    check(basic.status === 200, "HTTP Basic with the key as the password works too (Orthanc, PACS)");

    const wl = await dev(key, "/worklist");
    const wlRana = (wl.json?.appointments as any[] | undefined)?.find((a) => a.patient.id === rana.id);
    check(
      wl.status === 200 && wlRana?.patient.fileNo === 1 && wlRana?.patient.birthDate === "1990-05-02" && wlRana?.patient.sex === "F",
      "today's worklist names the patient with their file number, birth date and sex",
      JSON.stringify(wlRana?.patient)
    );
    check(!JSON.stringify(wl.json).includes("962790000101"), "and nothing a worklist does not need, like their phone");

    /* ── Images in ───────────────────────────────────────────────────── */
    console.log("\nimages from the device");
    const named = await upload(key, PNG, "photo.png", { patient: "#1", teeth: "11,21", kind: "photo" });
    const ranaFiles1 = await filesOf(rana.id);
    check(
      named.status === 201 && named.json?.placed === "patient" && named.json?.matchedBy === "sender" && ranaFiles1.some((f) => f.device_id === deviceId && f.kind === "photo" && f.teeth.join() === "11,21"),
      "an image naming file #1 lands in that patient's Files, from the device, with its teeth",
      JSON.stringify(named.json)
    );
    check(ranaFiles1.every((f) => f.uploaded_by === null), "with no person recorded as having uploaded it");

    const sOmar1 = uid();
    const study1 = uid();
    const dcmUntrusted = makeDicom({ sopUid: uid(), seriesUid: sOmar1, studyUid: study1, patientId: "2", patientName: "Aziz^Omar", description: "Panoramic" });
    const untrusted = await upload(key, dcmUntrusted, "IM0001");
    check(untrusted.json?.placed === "inbox", "a DICOM whose Patient ID the clinic does not trust, with nobody waiting, goes to the inbox", JSON.stringify(untrusted.json));
    check((await filesOf(omar.id)).length === 0, "not into file #2 on the machine's say-so");

    await fetchSession(page, `/api/c/${slug}/devices/${deviceId}`, "PATCH", { op: "update", matchBy: "clinicti" });
    const sOmar2 = uid();
    const dcm1 = makeDicom({ sopUid: uid(), seriesUid: sOmar2, studyUid: uid(), patientId: "2", patientName: "Aziz^Omar", description: "Panoramic", instanceNumber: 1 });
    const trusted = await upload(key, dcm1, "IM0002.dcm");
    let omarFiles = await filesOf(omar.id);
    const opg = omarFiles.find((f) => f.dicom?.seriesUid === sOmar2);
    check(trusted.json?.placed === "patient" && trusted.json?.matchedBy === "machine_id" && !!opg, "once the machine uses Clinicti numbers, Patient ID 2 files it to patient #2", JSON.stringify(trusted.json));
    check(opg?.mime_type === "image/png" && opg?.dicom?.preview === true && opg?.dicom?.modality === "PX", "it is kept with a PNG preview the browser can draw");
    check(opg?.dicom?.machinePatient?.name === "Omar Aziz", "and what the machine called the patient, in reading order");

    const dcm2 = makeDicom({ sopUid: uid(), seriesUid: sOmar2, studyUid: uid(), patientId: "2", patientName: "Aziz^Omar", instanceNumber: 2 });
    const second = await upload(key, dcm2, "IM0003.dcm");
    omarFiles = await filesOf(omar.id);
    check(
      second.json?.added === "series" && omarFiles.length === 1 && omarFiles[0].dicom.instances.length === 2,
      "the next slice of the series joins the same file instead of making another",
      JSON.stringify(second.json)
    );
    const again = await upload(key, dcm2, "IM0003.dcm");
    check(again.json?.added === "duplicate" && (await filesOf(omar.id))[0].dicom.instances.length === 2, "the same slice sent twice is stored once");

    const prev = await page.request.get(`${BASE}/api/c/${slug}/files/${opg!.id}`);
    const meta = await sharp(await prev.body()).metadata();
    check(prev.ok() && meta.format === "png" && meta.width === 64 && meta.height === 48, "the preview is the machine's picture at its own size", `${meta.format} ${meta.width}x${meta.height}`);
    const orig = await page.request.get(`${BASE}/api/c/${slug}/files/${opg!.id}/dicom`);
    const zip = await orig.body();
    check(orig.ok() && zip.subarray(0, 2).toString() === "PK" && zip.includes(Buffer.from("DICM")), "the originals download as a ZIP of .dcm files");

    // Take x-ray: the doctor is waiting; the machine's ID means nothing to Clinicti.
    const reqRes = await fetchSession(page, `/api/c/${slug}/imaging/requests`, "POST", { patientId: rana.id, teeth: ["36"] });
    const reqId = reqRes?.request?.id as string;
    const waiting = await dev(key, "/requests");
    check((waiting.json?.requests as any[])?.some((r) => r.id === reqId && r.patient.fileNo === 1), "the device sees who a doctor is waiting on, with the file number");
    const sRana = uid();
    const answered = await upload(key, makeDicom({ sopUid: uid(), seriesUid: sRana, studyUid: uid(), patientId: "SIRONA-77", patientName: "Haddad^Rana" }), "IM0004.dcm");
    const ranaOpg = (await filesOf(rana.id)).find((f) => f.dicom?.seriesUid === sRana);
    const [reqRow] = await q(`select fulfilled_at, file_id from imaging_requests where id = $1`, [reqId]);
    check(
      answered.json?.matchedBy === "open_request" && ranaOpg?.teeth.join() === "36" && reqRow.file_id === ranaOpg?.id,
      "an image the clinic cannot place by ID answers the doctor waiting: their patient, their tooth",
      JSON.stringify(answered.json)
    );

    const foreign = await upload(key, PNG, "stray.png", { patient: zaid.id });
    check(foreign.json?.placed === "inbox" && (await filesOf(zaid.id)).length === 0, "a patient id from another clinic files nothing there: it waits in this clinic's inbox");

    /* ── DICOMweb ────────────────────────────────────────────────────── */
    console.log("\nDICOMweb (STOW-RS)");
    const sStow = uid();
    const stowStudy = uid();
    const raw = Buffer.alloc(64 * 48);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 256;
    const jpeg = await sharp(raw, { raw: { width: 64, height: 48, channels: 1 } }).jpeg().toBuffer();
    const stow = stowBody([
      makeDicom({ sopUid: uid(), seriesUid: sStow, studyUid: stowStudy, patientId: "1", patientName: "Haddad^Rana", modality: "IO", jpeg, instanceNumber: 1 }),
      makeDicom({ sopUid: uid(), seriesUid: sStow, studyUid: stowStudy, patientId: "1", patientName: "Haddad^Rana", modality: "IO", instanceNumber: 2 }),
    ]);
    const stored = await dev(key, "/dicomweb/studies", { method: "POST", body: new Uint8Array(stow.body), headers: { "content-type": stow.contentType } });
    const ranaStow = (await filesOf(rana.id)).find((f) => f.dicom?.seriesUid === sStow);
    check(
      stored.status === 200 && stored.headers.get("content-type")?.includes("application/dicom+json") && (stored.json?.["00081199"]?.Value as unknown[])?.length === 2,
      "a relay's STOW-RS of two instances is stored, and answered in DICOM JSON",
      `${stored.status} ${JSON.stringify(stored.json)?.slice(0, 200)}`
    );
    check(ranaStow?.dicom?.instances.length === 2 && ranaStow.mime_type === "image/png", "as one file on patient #1, previewed from the JPEG-compressed frame");
    const junk = stowBody([Buffer.from("not dicom at all")]);
    const refused = await dev(key, "/dicomweb/studies", { method: "POST", body: new Uint8Array(junk.body), headers: { "content-type": junk.contentType } });
    check(refused.status === 409 && !!refused.json?.["00081198"], "something that is not DICOM is refused, instance by instance");

    /* ── Hands: the station, the Files tab ───────────────────────────── */
    console.log("\nthe station and the Files tab");
    const slice3 = makeDicom({ sopUid: uid(), seriesUid: sOmar2, studyUid: uid(), patientId: "2", patientName: "Aziz^Omar", instanceNumber: 3 });
    const viaStation = await page.request.post(`${BASE}/api/c/${slug}/imaging/receive`, {
      multipart: { file: { name: "IM0005", mimeType: "application/octet-stream", buffer: slice3 } },
    });
    const vs = await viaStation.json();
    check(vs.placed === "patient" && vs.added === "series" && vs.patientName === "Omar Aziz", "the station's next slice joins its series, whoever is waiting", JSON.stringify(vs));
    const wrongPatient = await page.request.post(`${BASE}/api/c/${slug}/patients/${rana.id}/files`, {
      multipart: { file: { name: "omar.dcm", mimeType: "application/dicom", buffer: dcm1 }, kind: "xray" },
    });
    check(wrongPatient.status() === 409, "uploading patient #2's series to patient #1 by hand is refused, not merged into the wrong file");
    const handDcm = makeDicom({ sopUid: uid(), seriesUid: uid(), studyUid: uid(), patientId: "", patientName: "", description: "Bitewing" });
    const byHand = await page.request.post(`${BASE}/api/c/${slug}/patients/${omar.id}/files`, {
      multipart: { file: { name: "bitewing.dcm", mimeType: "application/dicom", buffer: handDcm }, kind: "xray" },
    });
    const bh = await byHand.json();
    check(byHand.ok() && bh.file?.mime_type === "image/png", "a .dcm dropped on the Files tab gets a preview too");

    /* ── The inbox ───────────────────────────────────────────────────── */
    console.log("\nthe imaging inbox");
    await page.goto(`${BASE}/c/${slug}/imaging`, { timeout: 120000 });
    await page.waitForSelector("[data-inbox-item]", { timeout: 60000 });
    const items = page.locator("[data-inbox-item]");
    check((await items.count()) === 2, "the Imaging page lists the two images nobody could place", String(await items.count()));
    const said = await page.locator("[data-machine-said]").first().innerText();
    check(said.includes("Omar Aziz"), "showing what the machine called the patient", said);
    check((await page.locator("[data-station-devices]").innerText()).includes("OPG room 2"), "and which machines are talking");
    // A string, not a function: tsx would wrap a function in helpers the browser lacks.
    const drawn = await page
      .waitForFunction(
        "(() => { const i = document.querySelector('[data-inbox-item] img'); return i && i.complete && i.naturalWidth > 0 ? i.naturalWidth : false; })()",
        null,
        { timeout: 20000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => 0);
    check(drawn === 64, "with the picture itself, so a person can see whose x-ray it is", String(drawn));
    await page.screenshot({ path: join(SHOTS, "inbox.png"), fullPage: true });
    const dicomItem = items.filter({ hasText: "Panoramic" }).first();
    await dicomItem.locator("[data-inbox-search]").fill("#2");
    await dicomItem.locator(`[data-inbox-patient='${omar.id}']`).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-inbox-item]").length === 1, null, { timeout: 15000 });
    omarFiles = await filesOf(omar.id);
    check(omarFiles.some((f) => f.dicom?.seriesUid === sOmar1), "searching #2 and choosing them files the inbox image to that patient");
    const [strayItem] = await q(`select id, storage_path from imaging_inbox where clinic_id = $1 and assigned_at is null and discarded_at is null`, [clinic.id]);
    const strayPath = join(STORAGE, strayItem.storage_path);
    const existedBefore = existsSync(strayPath);
    await page.locator("[data-inbox-item] [data-discard]").click();
    await page.getByRole("button", { name: "Discard" }).last().click();
    await page.waitForFunction(() => document.querySelectorAll("[data-inbox-item]").length === 0, null, { timeout: 15000 });
    check(existedBefore && !existsSync(strayPath), "discarding a stray image deletes it");

    /* ── The patient's file ──────────────────────────────────────────── */
    console.log("\nthe patient's file");
    await page.goto(`${BASE}/c/${slug}/patients/${omar.id}?tab=files`, { timeout: 120000 });
    await page.waitForSelector("[data-file-no]", { timeout: 60000 });
    check((await page.locator("[data-file-no]").innerText()).trim() === "File 2", "the profile shows the file number to type into a machine");
    await page.waitForSelector("[data-file-dicom]", { timeout: 30000 });
    check((await page.locator("[data-file-dicom='3']").count()) === 1, "the Files tab offers the 3-slice series' originals");
    check((await page.locator("[data-file-device]").first().innerText()).includes("OPG room 2"), "and says which machine sent it");
    await page.screenshot({ path: join(SHOTS, "files.png") });
    const found = await page.request.get(`${BASE}/api/c/${slug}/patients/search?q=%232`);
    check(((await found.json()).results as any[]).some((r) => r.id === omar.id), "searching #2 finds the patient by file number");

    /* ── Keys change and stop ────────────────────────────────────────── */
    console.log("\nnew keys and revoking");
    const rekey = await fetchSession(page, `/api/c/${slug}/devices/${deviceId}`, "PATCH", { op: "rekey" });
    const fresh = rekey?.key as string;
    check((await dev(key, "/me")).status === 401 && (await dev(fresh, "/me")).status === 200, "a new key works at once and the old one stops");
    await fetchSession(page, `/api/c/${slug}/devices/${deviceId}`, "PATCH", { op: "revoke" });
    check((await dev(fresh, "/me")).status === 401, "revoking the device stops its key");
    const [counted] = await q(`select images_received, last_seen_at from clinic_devices where id = $1`, [deviceId]);
    check(counted.images_received >= 8 && counted.last_seen_at, "the device's count and last contact are kept", JSON.stringify(counted));

    /* ── Who may ─────────────────────────────────────────────────────── */
    console.log("\nwho may manage devices");
    const desk = await signIn(browser, `dev-desk-${tag}@test.local`);
    desk.on("pageerror", (e) => errors.push(`[desk] ${e.message}`));
    const deskPost = await desk.request.post(`${BASE}/api/c/${slug}/devices`, { data: { name: "Sneaky", kind: "xray" } });
    check(deskPost.status() === 403, "a receptionist without clinic settings cannot make a device key");
    await desk.goto(`${BASE}/c/${slug}/settings`, { timeout: 120000 });
    await desk.waitForLoadState("networkidle");
    check((await desk.locator(`a[href='/c/${slug}/settings/devices']`).count()) === 0, "nor sees the Devices tab");

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = any($1)`, [[clinic.id, other.id]]);
    await q(`delete from users where email like $1`, [`dev-%-${tag}@test.local`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

/** A call as the signed-in person, through the page's own cookies. */
async function fetchSession(page: Page, path: string, method: string, data: unknown): Promise<Record<string, any> | null> {
  const res = await page.request.fetch(`${BASE}${path}`, { method, data });
  return (await res.json().catch(() => null)) as Record<string, any> | null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
