/**
 * The doctor connects a machine, start to finish, with the real Clinicti
 * Bridge: Settings → Devices → Connect a machine, the code typed into the
 * Bridge's own window, a (simulated) OPG pressing Test, asking for the
 * worklist and sending a picture, a sensor's folder, and a revoked device.
 * Every step is checked on both screens — the wizard in Clinicti ticking,
 * and the Bridge window — and in the database.
 *
 * Runs the Bridge from source on spare ports. Needs a warm dev server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client as Pg } from "pg";
import bcrypt from "bcryptjs";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dimse from "dcmjs-dimse";
import { makeDicom, uid } from "./lib-dicom-fixture";

dimse.log.setLevel("error");

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const UI_PORT = 8797;
const DICOM_PORT = 11119;
const SHOTS = path.join(process.cwd(), "scripts", "qa-shots", "bridge");
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(500);
    v = await fn();
  }
  return v;
}

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

/** One DIMSE request against the Bridge, as a machine would make it. */
function dicom<T>(request: dimse.requests.Request, collect: (r: dimse.responses.Response) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new dimse.Client();
    request.on("response", collect as (r: unknown) => void);
    client.addRequest(request);
    client.on("networkError", reject);
    client.on("closed", () => resolve());
    client.send("127.0.0.1", DICOM_PORT, "OPG_ROOM2", "CLINICTI");
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const db = new Pg({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const slug = `qabridge${tag}`;
  const hash = bcrypt.hashSync("password123", 10);

  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features, timezone) values ('QA Smile Clinic','عيادة',$1,'dental','{dental}','{"dental": true}','Asia/Amman') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const [owner] = await q(`insert into users (email, password_hash, full_name, locale) values ($1,$2,'Dr. Hala Saeed','en') returning id`, [`bridge-doc-${tag}@test.local`, hash]);
  const [member] = await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}') returning id`,
    [clinic.id, owner.id]
  );
  const [rana] = await q(
    `insert into patients (clinic_id, full_name, birth_date, gender, source) values ($1,'Rana Haddad','1990-05-02','female','staff') returning id, file_no`,
    [clinic.id]
  );
  await q(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status) values ($1,$2,$3, now() + interval '30 minutes', now() + interval '1 hour', 'confirmed')`,
    [clinic.id, rana.id, member.id]
  );

  // The Bridge, from source, with its own folder and ports.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "qa-bridge-"));
  fs.writeFileSync(
    path.join(data, "config.json"),
    JSON.stringify({ server: BASE, key: null, device: null, clinic: null, folders: [], dicom: { enabled: true, port: DICOM_PORT, aet: "CLINICTI" }, uiPort: UI_PORT, autostart: false })
  );
  const bridge: ChildProcess = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "bridge/src/main.ts", "--foreground", "--data", data, "--server", BASE, "--ui-port", String(UI_PORT)], {
    stdio: "ignore",
    // No Windows notifications popping up on the desktop of whoever runs this.
    env: { ...process.env, CLINICTI_BRIDGE_NO_BROWSER: "1" },
    windowsHide: true,
  });
  const bridgeState = async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${UI_PORT}/api/state`)).json()) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const bridgePost = (p: string, body: unknown = {}) =>
    fetch(`http://127.0.0.1:${UI_PORT}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-bridge-ui": "1" }, body: JSON.stringify(body) }).then((r) => r.json());
  const filesOf = (pid: string) => q(`select file_name, kind, device_id, dicom, mime_type from patient_files where patient_id = $1 order by created_at`, [pid]);

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    await until(bridgeState, (s) => !!s, 30000);
    console.log("\nthe doctor starts in Clinicti");
    const page = await signIn(browser, `bridge-doc-${tag}@test.local`);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/c/${slug}/settings/devices`, { timeout: 120000 });
    await page.click("[data-connect-machine]", { timeout: 120000 });
    const wizard = page.locator("[data-connect-wizard]");
    check((await wizard.locator("[data-choice]").count()) === 4, "Connect a machine asks what kind: camera, sensor software, DICOM machine, anything else");
    await page.waitForTimeout(400); // the dialog fades in
    await page.screenshot({ path: path.join(SHOTS, "1-choose.png") });
    await wizard.locator("[data-choice='camera']").click();
    check((await wizard.innerText()).includes("Press Camera"), "a USB camera needs nothing installed: the steps say so");
    await page.getByRole("button", { name: "Back" }).click();
    await wizard.locator("[data-choice='dicom']").click();
    await wizard.locator("[data-wizard-name]").fill("OPG room 2");
    await page.click("[data-wizard-create]");
    const codeEl = wizard.locator("[data-pair-code]");
    await codeEl.waitFor({ timeout: 20000 });
    const code = (await codeEl.getAttribute("data-pair-code")) ?? "";
    check(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code), "naming it gives a six-letter code to type into the Bridge", code);
    await page.screenshot({ path: path.join(SHOTS, "2-code.png") });

    const dl = await fetch(`${BASE}/api/c/${slug}/devices/bridge`, {
      headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    check(
      dl.status === 200 && /portable-executable/.test(dl.headers.get("content-type") ?? "") && Number(dl.headers.get("content-length")) > 50_000_000,
      "Download Clinicti Bridge serves the Windows program",
      `${dl.status} ${dl.headers.get("content-type")} ${dl.headers.get("content-length")}`
    );
    await dl.body?.cancel();

    console.log("\nthe Bridge window, on the imaging computer");
    const bw = await browser.newPage({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 2 });
    bw.on("pageerror", (e) => errors.push(`[bridge] ${e.message}`));
    await bw.goto(`http://127.0.0.1:${UI_PORT}/`);
    await bw.locator("#pair:not([hidden])").waitFor({ timeout: 15000 });
    await bw.fill("#code", "AAA-AAA");
    await bw.click("#pairBtn");
    await bw.locator("#pairNote:not([hidden])").waitFor({ timeout: 15000 });
    check((await bw.locator("#pairNote").innerText()).includes("not right"), "a wrong code is refused, in words a doctor reads");
    await bw.fill("#code", code.toLowerCase().replace("-", " "));
    await bw.click("#pairBtn");
    await bw.locator("#connected:not([hidden])").waitFor({ timeout: 20000 });
    check((await bw.locator("#who").innerText()).includes("QA Smile Clinic") && (await bw.locator("#who").innerText()).includes("OPG room 2"), "the right code, however typed, connects it: the clinic and the machine's name show");
    const [dev] = await q(`select id, paired_at, method, pair_code_hash from clinic_devices where clinic_id = $1`, [clinic.id]);
    check(dev.paired_at && dev.method === "bridge" && dev.pair_code_hash === null, "and the code is used up");
    const cfg = JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8"));
    check(/^ctd_/.test(cfg.key) && !(await bw.content()).includes(cfg.key), "the Bridge holds its own key; nobody is shown it");

    await wizard.locator("[data-wizard-step='install'][data-done]").waitFor({ timeout: 20000 });
    check(true, "back in Clinicti, step 1 turns green by itself");
    await wizard.locator("[data-dicom-destination]").filter({ hasText: String(DICOM_PORT) }).waitFor({ timeout: 20000 });
    const dest = await wizard.locator("[data-dicom-destination]").innerText();
    check(dest.includes(String(DICOM_PORT)) && dest.includes("CLINICTI") && /\d+\.\d+\.\d+\.\d+/.test(dest), "and shows the address, port and AE title to type into the machine", dest.replace(/\s+/g, " "));

    console.log("\nthe machine");
    let echoed = false;
    await dicom(new dimse.requests.CEchoRequest(), (r) => (echoed = r.getStatus() === dimse.constants.Status.Success));
    check(echoed, "the machine's Test button (C-ECHO) is answered");
    await wizard.locator("[data-status='echo'][data-ok]").waitFor({ timeout: 20000 });
    check(true, "and Clinicti's step 2 turns green: the machine reached the Bridge");
    check((await bw.locator("#cEcho").getAttribute("class")) === "yes" || (await until(async () => bw.locator("#cEcho").getAttribute("class"), (c) => c === "yes", 8000)) === "yes", "the Bridge window ticks it too");

    const found: Record<string, unknown>[] = [];
    await dicom(dimse.requests.CFindRequest.createWorklistFindRequest({ PatientName: "*", ScheduledProcedureStepSequence: [{ Modality: "PX", ScheduledProcedureStepStartDate: "" }] }), (r) => {
      if (r.getStatus() === dimse.constants.Status.Pending && r.getDataset()) found.push(r.getDataset()!.getElements());
    });
    const wl = found.find((x) => x.PatientID === `CLN-${rana.file_no}`);
    // dcmjs reads a person name back as [{ Alphabetic: "Family^Given" }].
    const pn = (v: unknown) => (Array.isArray(v) ? (v[0] as { Alphabetic?: string } | undefined)?.Alphabetic : v);
    check(
      !!wl && pn(wl.PatientName) === "Haddad^Rana" && wl.PatientBirthDate === "19900502" && wl.PatientSex === "F",
      "the machine's worklist lists today's patient with Patient ID CLN-<file number>",
      JSON.stringify(found).slice(0, 300)
    );
    check(((wl?.ScheduledProcedureStepSequence as Record<string, unknown>[] | undefined)?.[0]?.Modality as string) === "PX", "with the modality the machine asked for");

    const study = uid();
    const shot = path.join(data, "opg.dcm");
    fs.writeFileSync(shot, makeDicom({ sopUid: uid(), seriesUid: uid(), studyUid: study, patientId: `CLN-${rana.file_no}`, patientName: "Haddad^Rana", description: "Panoramic" }));
    let stored = false;
    await dicom(new dimse.requests.CStoreRequest(shot), (r) => (stored = r.getStatus() === dimse.constants.Status.Success));
    check(stored, "the machine sends the picture (C-STORE) and the Bridge accepts it");
    const ranaFiles = await until(() => filesOf(rana.id), (f) => f.some((x) => x.dicom?.studyUid === study), 30000);
    const opg = ranaFiles.find((x) => x.dicom?.studyUid === study);
    check(opg && opg.device_id === dev.id && opg.mime_type === "image/png", "it lands in the patient's file, from this machine, with a preview — picked from the worklist, so nobody chose the patient by hand");
    await wizard.locator("[data-status='arrived'][data-ok]").waitFor({ timeout: 20000 });
    check((await wizard.locator("[data-status='arrived']").innerText()).includes("Rana Haddad"), "the wizard's last step says where it went: Rana Haddad's file");
    check(await wizard.locator("[data-all-set]").count(), "and the machine is shown as connected");
    await page.screenshot({ path: path.join(SHOTS, "3-connected.png") });

    console.log("\na sensor's folder");
    const folder = path.join(data, "XrayExport");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "already-there.png"), PNG);
    const added = await bridgePost("/api/folders/add", { path: folder });
    check(added.ok, "a folder is added to the Bridge");
    await sleep(500);
    fs.writeFileSync(path.join(folder, "IMG_0001.png"), PNG);
    fs.writeFileSync(path.join(folder, "upper-arch.stl"), Buffer.from("solid scan\nendsolid scan\n"));
    const inbox = await until(
      () => q(`select file_name, kind from imaging_inbox where clinic_id = $1 order by received_at`, [clinic.id]),
      (r) => r.length >= 2,
      30000
    );
    check(inbox.some((r) => r.file_name === "IMG_0001.png") && !inbox.some((r) => r.file_name === "already-there.png"), "a new picture in the folder is sent; what was there before is not");
    check(inbox.some((r) => r.file_name === "upper-arch.stl" && r.kind === "other"), "a 3D scan's STL is sent too, kept as a file");
    await bw.reload();
    await bw.locator("#connected:not([hidden])").waitFor();
    await sleep(2500);
    check((await bw.locator("#folders").innerText()).includes("Watching"), "the Bridge window shows the folder being watched");
    await bw.screenshot({ path: path.join(SHOTS, "4-bridge-window.png"), fullPage: true });

    console.log("\nTake x-ray, at the imaging computer");
    // A harmless program stands in for the imaging software: it writes down what it was opened with.
    const echoScript = path.join(data, "opened-with.cjs");
    const echoOut = path.join(data, "opened-with.json");
    fs.writeFileSync(echoScript, `require("fs").writeFileSync(${JSON.stringify(echoOut)}, JSON.stringify(process.argv.slice(2)));`);
    await bridgePost("/api/on-request", { command: `"${process.execPath}" "${echoScript}" {patientId} "{fullName}" {birthDate} {teeth}` });
    const asked = await page.request.fetch(`${BASE}/api/c/${slug}/imaging/requests`, { method: "POST", data: { patientId: rana.id, teeth: ["46"] } });
    const askedId = ((await asked.json()) as { request?: { id: string } }).request?.id;
    const st = await until(bridgeState, (s) => !!s && ((s.waiting as { id: string }[]) ?? []).some((w) => w.id === askedId), 20000);
    check(st?.waiting?.[0]?.patient?.name === "Rana Haddad", "the Bridge sees the doctor waiting, within seconds");
    await bw.reload();
    await bw.locator(`[data-waiting='${askedId}']`).waitFor({ timeout: 10000 });
    check((await bw.locator(`[data-waiting='${askedId}']`).innerText()).includes(`CLN-${rana.file_no}`), "its window puts the patient at the top: name, file number, tooth");
    const opened = await until(
      async () => {
        try {
          return JSON.parse(fs.readFileSync(echoOut, "utf8")) as string[];
        } catch {
          return null;
        }
      },
      (v) => !!v,
      15000
    );
    check(
      JSON.stringify(opened) === JSON.stringify([`CLN-${rana.file_no}`, "Rana Haddad", "19900502", "46"]),
      "and opens the imaging software on that patient, with the clinic's own command",
      JSON.stringify(opened)
    );
    await bw.screenshot({ path: path.join(SHOTS, "6-xray-wanted.png") });
    await page.request.fetch(`${BASE}/api/c/${slug}/imaging/requests/${askedId}`, { method: "POST", data: { op: "cancel" } });

    console.log("\nwhen the clinic removes the machine");
    await page.request.fetch(`${BASE}/api/c/${slug}/devices/${dev.id}`, { method: "PATCH", data: { op: "revoke" } });
    await bridgePost("/api/test");
    const after = await until(bridgeState, (s) => !!s && s.paired === false, 30000);
    check(after?.paired === false && after?.notice === "key_revoked", "the Bridge notices at once, stops, and asks to be connected again");
    await bw.reload();
    await bw.locator("#pairNote:not([hidden])").waitFor({ timeout: 10000 });
    check((await bw.locator("#pairNote").innerText()).includes("disconnected"), "saying so in its window");

    console.log("\nconnecting it again, for a sensor that saves to a folder");
    await page.goto(`${BASE}/c/${slug}/settings/devices`, { timeout: 120000 });
    await page.click("[data-connect-machine]");
    await wizard.locator("[data-choice='folder']").click();
    await wizard.locator("[data-wizard-name]").fill("Sensor, room 1");
    await page.click("[data-wizard-create]");
    await wizard.locator("[data-pair-code]").waitFor({ timeout: 20000 });
    const code2 = (await wizard.locator("[data-pair-code]").getAttribute("data-pair-code")) ?? "";
    check((await wizard.innerText()).includes("Expires in 15 min"), "a fresh code has its full fifteen minutes");
    await bw.fill("#code", code2);
    await bw.click("#pairBtn");
    await bw.locator("#connected:not([hidden])").waitFor({ timeout: 20000 });
    check((await bw.locator("#who").innerText()).includes("Sensor, room 1"), "the same Bridge connects again, as the new machine");
    await wizard.locator("[data-wizard-step='folder'][data-done]").waitFor({ timeout: 20000 });
    check((await wizard.locator("[data-status='watching']").first().innerText()).includes("XrayExport"), "the wizard's folder step shows which folder the Bridge is watching");
    fs.writeFileSync(path.join(folder, "IMG_0002.png"), PNG);
    await wizard.locator("[data-status='arrived'][data-ok]").waitFor({ timeout: 30000 });
    check((await wizard.locator("[data-status='arrived']").innerText()).includes("imaging inbox"), "and its last step: the sensor's picture arrived, in the imaging inbox until someone files it");
    await page.screenshot({ path: path.join(SHOTS, "5-folder-connected.png") });
    await page.click("[data-wizard-close]");
    await page.locator("[data-bridge-line]").first().waitFor({ timeout: 10000 });
    check((await page.locator("[data-bridge-line]").first().innerText()).includes("Watching a folder"), "the device list says what the Bridge is doing");

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    bridge.kill();
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]);
    await q(`delete from users where email = $1`, [`bridge-doc-${tag}@test.local`]);
    await db.end();
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
