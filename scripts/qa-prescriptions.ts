/**
 * Prescriptions: written in the patient file, sent to the patient on WhatsApp.
 *
 * Four things have to hold, and most of this file is about the first two:
 *
 *   - Who may write one. It goes out under a doctor's name and signature, so
 *     the permission is its own, a doctor on custom access inherits it and
 *     nobody else does, and the doctor is told when somebody else used it.
 *   - What the print URL is worth. The PDF page is reachable without a session
 *     (the renderer has no cookie), so the signature is all that stands
 *     between a prescription id and a patient's medicines.
 *   - That it arrives: one WhatsApp document, PDF attached, the medicines
 *     written out in the caption in the language the writer chose, on the
 *     patient's own thread.
 *   - That it is quick. The clinic's list learns each medicine, picking it
 *     again fills the rest of the line, templates apply in one tap, and Repeat
 *     opens an old one filled in.
 *
 * Needs the dev stack: web on APP_URL and the worker (the PDF renderer).
 */
try { process.loadEnvFile?.(); } catch {}

import path from "node:path";
import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { ar } from "../src/lib/i18n/ar";

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

const A = ar.prescriptions;

async function main() {
  const { printKeyFor } = await import("../src/lib/print-token");
  const { saveFile } = await import("../src/lib/storage");
  const { resolveCapabilities } = await import("../src/lib/permissions");
  const { maskByFeatures, resolveFeatures } = await import("../src/lib/features");
  const lib = await import("../src/lib/prescriptions");

  /* ================================================================ pure */
  console.log("\n[who holds the permission]");
  const custom = (caps: Record<string, boolean>) => ({ level: "custom", caps });
  check(
    "a doctor on custom access inherits it from Patients",
    resolveCapabilities(custom({ patients: true }), { isOwner: false, role: "doctor" })["patients.prescriptions"]
  );
  check(
    "a receptionist on custom access does not",
    !resolveCapabilities(custom({ patients: true }), { isOwner: false, role: "receptionist" })["patients.prescriptions"]
  );
  check(
    "an explicit no is honoured, even for a doctor",
    !resolveCapabilities(custom({ patients: true, "patients.prescriptions": false }), {
      isOwner: false,
      role: "doctor",
    })["patients.prescriptions"]
  );
  check(
    "a ticked receptionist has it",
    resolveCapabilities(custom({ patients: true, "patients.prescriptions": true }), {
      isOwner: false,
      role: "receptionist",
    })["patients.prescriptions"]
  );
  check(
    "without Patients nobody does",
    !resolveCapabilities(custom({ "patients.prescriptions": true }), { isOwner: false, role: "doctor" })[
      "patients.prescriptions"
    ]
  );
  check("the owner always does", resolveCapabilities({}, { isOwner: true, role: "other" })["patients.prescriptions"]);
  check(
    "a clinic without the patients module has it switched off",
    !maskByFeatures(
      resolveCapabilities({ level: "full" }, { isOwner: false, role: "doctor" }),
      resolveFeatures({ patients: false })
    )["patients.prescriptions"]
  );

  console.log("\n[the wording]");
  const cleaned = lib.cleanItems([
    { name: "  Amoxicillin 500mg ", dose: "1 capsule", frequency: "", duration: "7 days", instructions: "" },
    { name: "", dose: "forgotten row" },
    { name: "x".repeat(400) },
    "junk",
  ]);
  check("unnamed rows are dropped, names trimmed", cleaned.length === 2 && cleaned[0].name === "Amoxicillin 500mg");
  check("every field is capped", cleaned[1].name.length === 200);
  const swapped = lib.switchItemLanguage(
    { name: "Panadol", dose: "حبة واحدة", frequency: "3 مرات يومياً", duration: "كما وصف الطبيب", instructions: "" },
    "ar",
    "en"
  );
  check(
    "switching language carries tapped answers across",
    swapped.dose === "1 tablet" && swapped.frequency === "3 times a day",
    JSON.stringify(swapped)
  );
  check("and leaves typed ones as they were", swapped.duration === "كما وصف الطبيب");
  check(
    "the caption lists one medicine a line with its instructions beneath",
    lib.formatMedicineLines(cleaned.slice(0, 1)) === "1. Amoxicillin 500mg\n   1 capsule · 7 days",
    JSON.stringify(lib.formatMedicineLines(cleaned.slice(0, 1)))
  );
  check("numbers read RX-0042", lib.rxNumber(42) === "RX-0042");

  /* ================================================================ fixture */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `qarx${stamp}`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency)
       values ('QA Rx Clinic','عيادة الوصفات',$1,'ar','Asia/Amman','JOD') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  // Connected, or the send is refused before it is attempted.
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1,'connected')`, [clinicId]);

  const mkUser = async (tag: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;
  const mkMember = async (userId: string, role: string, perms: unknown, owner = false) =>
    (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1,$2,$3,$4,$5) returning id`,
        [clinicId, userId, role, owner, JSON.stringify(perms)]
      )
    ).rows[0].id as string;

  const ownerId = await mkUser("owner", "مالك العيادة");
  await mkMember(ownerId, "other", { level: "full" }, true);
  // A doctor on custom access whose map predates prescriptions: silence.
  const doctorId = await mkUser("doctor", "د. سامي خليل");
  const doctorMember = await mkMember(doctorId, "doctor", custom({ dashboard: true, calendar: true, patients: true }));
  // The assistant who types what the doctor dictates.
  const assistantId = await mkUser("assistant", "سارة المساعدة");
  await mkMember(
    assistantId,
    "receptionist",
    custom({ dashboard: true, patients: true, "patients.prescriptions": true })
  );
  // The desk: may open files, may not write prescriptions.
  const deskId = await mkUser("desk", "موظف الاستقبال");
  await mkMember(deskId, "receptionist", custom({ dashboard: true, patients: true }));
  // And somebody who may not open a file at all.
  const outsiderId = await mkUser("outsider", "بلا ملفات");
  await mkMember(outsiderId, "receptionist", custom({ dashboard: true, conversations: true }));

  const PHONE = "+962790771122";
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source) values ($1,'أحمد يوسف',$2,'staff') returning id`,
      [clinicId, PHONE]
    )
  ).rows[0].id as string;
  const noPhone = (
    await db.query(
      `insert into patients (clinic_id, full_name, source) values ($1,'مريض بلا رقم','staff') returning id`,
      [clinicId]
    )
  ).rows[0].id as string;
  // Seen by the doctor this morning, so an assistant's composer picks them.
  await db.query(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
     values ($1,$2,$3, now() - interval '2 hours', now() - interval '90 minutes','completed')`,
    [clinicId, patient, doctorMember]
  );

  const browser = await chromium.launch();

  // The doctor's saved signature, drawn the way the signature pad would.
  {
    const p = await browser.newPage();
    await p.setContent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" style="background:transparent">
         <path d="M10 90 C 40 10, 70 10, 90 80 S 150 110, 170 40 S 230 20, 250 85 S 320 60, 350 30"
               fill="none" stroke="#1b2a55" stroke-width="4" stroke-linecap="round"/></svg>`
    );
    const png = await p.locator("svg").screenshot({ omitBackground: true });
    await p.close();
    const saved = await saveFile(clinicId, "signatures", `qa-${stamp}.png`, png);
    await db.query(`update users set signature_png_path = $2 where id = $1`, [doctorId, saved.storagePath]);
  }
  console.log(`\n✓ fixture clinic ${slug}`);

  const ctx = async (email: string, viewport = { width: 1360, height: 900 }) => {
    const c = await browser.newContext({ viewport });
    const pg = await c.newPage();
    await signIn(pg, email);
    return { c, pg };
  };
  const hideDevOverlay = (pg: Page) => pg.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  const openFile = async (pg: Page, id: string, tab?: string) => {
    await pg.goto(`${BASE}/c/${slug}/patients/${id}${tab ? `?tab=${tab}` : ""}`);
    await pg.waitForLoadState("networkidle");
    await hideDevOverlay(pg);
  };
  const dialog = (pg: Page) => pg.getByRole("dialog");

  try {
    /* ============================================================ routes */
    console.log("\n[the routes, both directions]");
    const anon = await browser.newContext();
    const anonComposer = await anon.request.get(`${BASE}/api/c/${slug}/prescriptions/composer`);
    check("signed out, the composer data is refused", [401, 403].includes(anonComposer.status()), String(anonComposer.status()));
    await anon.close();

    const desk = await ctx(`desk-${slug}@test.local`);
    const deskComposer = await desk.pg.request.get(`${BASE}/api/c/${slug}/prescriptions/composer`);
    check("the desk without the permission is refused it", deskComposer.status() === 403, String(deskComposer.status()));

    const doc = await ctx(`doctor-${slug}@test.local`);
    const composerRes = await doc.pg.request.get(`${BASE}/api/c/${slug}/prescriptions/composer?patient=${patient}`);
    check("the doctor gets it", composerRes.status() === 200, String(composerRes.status()));
    const composer = (await composerRes.json()) as {
      doctors: { member_id: string; name: string; has_signature: boolean }[];
      lastDoctor: string | null;
      captions: { ar: string; en: string };
    };
    check(
      "the prescribers are the doctor and the owner",
      composer.doctors.length === 2 && composer.doctors.some((d) => d.member_id === doctorMember),
      composer.doctors.map((d) => d.name).join(", ")
    );
    check("and it knows the doctor's signature is saved", composer.doctors.find((d) => d.member_id === doctorMember)?.has_signature === true);
    check("it knows who saw this patient last", composer.lastDoctor === doctorMember);
    check("it carries the caption wording", composer.captions.ar.includes("{{prescription.medicines}}"));

    /* ============================================================ the doctor writes one */
    console.log("\n[a doctor writes one and sends it]");
    await openFile(doc.pg, patient);
    const quick = doc.pg.getByRole("button", { name: A.quickAction, exact: true });
    check("the file offers it in the header", (await quick.count()) === 1);
    await quick.click();
    await dialog(doc.pg).waitFor();
    check("it opens at once", await dialog(doc.pg).isVisible());

    const name0 = doc.pg.getByRole("combobox", { name: A.medicineName }).first();
    await name0.fill("Amoxicillin 500mg");
    // The one-tap answers, under the medicine being written.
    for (const chip of ["كبسولة واحدة", "3 مرات يومياً", "7 أيام", "بعد الأكل"]) {
      await doc.pg.getByRole("button", { name: chip, exact: true }).click();
    }
    await doc.pg.getByRole("textbox", { name: A.diagnosis }).fill("التهاب حلق");
    check(
      "a tapped answer fills its field",
      (await doc.pg.getByRole("textbox", { name: A.frequency }).first().inputValue()) === "3 مرات يومياً"
    );
    const preview = (await dialog(doc.pg).innerText()).replace(/\s+/g, " ");
    check(
      "the preview shows what the patient will read",
      preview.includes("Amoxicillin 500mg") && preview.includes("كبسولة واحدة · 3 مرات يومياً · 7 أيام · بعد الأكل"),
      ""
    );
    check("and leaves the diagnosis out of the message", !/وصفتك[\s\S]*التهاب حلق/.test(preview.split(A.preview)[1] ?? ""));

    if (SHOTS) await dialog(doc.pg).screenshot({ path: path.join(SHOTS, "composer-desktop.png") });

    await doc.pg.getByRole("button", { name: A.send, exact: true }).click();
    await dialog(doc.pg).waitFor({ state: "detached", timeout: 90_000 });

    const rx1 = (
      await db.query(
        `select rx.*, m.msg_type, m.media_mime, m.media_name, m.body, m.status, cv.patient_id as thread_patient
           from prescriptions rx
           left join messages m on m.id = rx.message_id
           left join conversations cv on cv.id = m.conversation_id
          where rx.clinic_id = $1 order by rx.number`,
        [clinicId]
      )
    ).rows[0];
    check("it is saved", !!rx1, "");
    check("numbered first in the clinic's series", rx1?.number === 1, String(rx1?.number));
    check("in the language chosen", rx1?.locale === "ar");
    check("with the diagnosis on the record", rx1?.diagnosis === "التهاب حلق");
    // Field by field: jsonb keeps its own key order, not the one written.
    const it0 = (rx1?.items ?? [])[0] ?? {};
    check(
      "and the medicine as written",
      rx1?.items?.length === 1 &&
        it0.name === "Amoxicillin 500mg" &&
        it0.dose === "كبسولة واحدة" &&
        it0.frequency === "3 مرات يومياً" &&
        it0.duration === "7 أيام" &&
        it0.instructions === "بعد الأكل",
      JSON.stringify(rx1?.items)
    );
    check("signed, since the doctor has a signature", rx1?.signed === true);
    check("its PDF was made", !!rx1?.pdf_path);
    check("one WhatsApp document went out", rx1?.msg_type === "document" && rx1?.media_mime === "application/pdf", `${rx1?.msg_type} ${rx1?.media_mime}`);
    check("named as a prescription", String(rx1?.media_name).startsWith(`${A.sheet.title} RX-0001`), rx1?.media_name);
    check(
      "its caption lists the medicine",
      String(rx1?.body).includes("1. Amoxicillin 500mg") && String(rx1?.body).includes("3 مرات يومياً"),
      JSON.stringify(rx1?.body)
    );
    check("without the diagnosis", !String(rx1?.body).includes("التهاب حلق"));
    check("on the patient's own thread", rx1?.thread_patient === patient);

    const med = (await db.query(`select * from medications where clinic_id = $1`, [clinicId])).rows;
    check(
      "the clinic's list learned the medicine, and how it was written",
      med.length === 1 && med[0].dose === "كبسولة واحدة" && med[0].frequency === "3 مرات يومياً" && med[0].use_count === 1,
      JSON.stringify(med.map((m) => [m.name, m.dose, m.frequency, m.use_count]))
    );
    const trail = (
      await db.query(
        `select action from audit_log where clinic_id = $1 and entity = 'prescription' order by created_at`,
        [clinicId]
      )
    ).rows.map((r) => r.action);
    check("writing and sending are both recorded", trail.includes("prescription.create") && trail.includes("prescription.send"), trail.join(","));
    check(
      "a doctor is not notified about their own",
      (await db.query(`select 1 from notifications where user_id = $1 and kind = 'prescription_in_your_name'`, [doctorId])).rowCount === 0
    );

    const tabText = (await doc.pg.locator("main").innerText()).replace(/\s+/g, " ");
    check("the file switched to its prescriptions", tabText.includes("RX-0001") && tabText.includes("Amoxicillin 500mg"));

    /* ============================================================ the PDF */
    console.log("\n[the PDF, and what its URL is worth]");
    const rxId = rx1.id as string;
    const bare = await doc.pg.request.get(`${BASE}/rx-print/${rxId}`);
    check("no signature, no prescription", bare.status() === 404, String(bare.status()));
    const forged = await doc.pg.request.get(`${BASE}/rx-print/${rxId}?kind=prescription&exp=${Date.now() + 60000}&sig=nope`);
    check("a made-up signature is refused", forged.status() === 404, String(forged.status()));
    const k0 = printKeyFor(rxId, "prescription");
    const expired = await doc.pg.request.get(`${BASE}/rx-print/${rxId}?kind=prescription&exp=${Date.now() - 1000}&sig=${k0.sig}`);
    check("an expired one is refused", expired.status() === 404, String(expired.status()));
    const patientKey = printKeyFor(rxId, "patient");
    const wrongKind = await doc.pg.request.get(`${BASE}/rx-print/${rxId}?kind=patient&exp=${patientKey.exp}&sig=${patientKey.sig}`);
    check("a patient-record key does not open a prescription", wrongKind.status() === 404, String(wrongKind.status()));

    const k = printKeyFor(rxId, "prescription");
    const sheet = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    await sheet.goto(`${BASE}/rx-print/${rxId}?kind=prescription&exp=${k.exp}&sig=${k.sig}`);
    await sheet.waitForLoadState("networkidle");
    const sheetText = (await sheet.locator("main").innerText()).replace(/\s+/g, " ");
    check("the sheet names the patient, the doctor and the clinic",
      sheetText.includes("أحمد يوسف") && sheetText.includes("د. سامي خليل") && sheetText.includes("عيادة الوصفات"));
    check("it carries the number and the diagnosis", sheetText.includes("RX-0001") && sheetText.includes("التهاب حلق"));
    check("and the medicine with its instructions", sheetText.includes("Amoxicillin 500mg") && sheetText.includes("بعد الأكل"));
    check("the doctor's signature is on it", (await sheet.locator('img[src^="data:image/png"]').count()) === 1);
    check("laid out right to left", (await sheet.locator("main").getAttribute("dir")) === "rtl");
    if (SHOTS) await sheet.screenshot({ path: path.join(SHOTS, "rx-ar.png"), fullPage: true });
    await sheet.close();

    const pdfRes = await doc.pg.request.get(`${BASE}/api/c/${slug}/prescriptions/${rxId}/pdf`);
    const pdfBody = await pdfRes.body();
    check("the file serves the PDF", pdfRes.status() === 200 && pdfBody.subarray(0, 5).toString("latin1") === "%PDF-", String(pdfRes.status()));
    check("inline, ready for the print dialog", /inline/.test(pdfRes.headers()["content-disposition"] ?? ""));
    const deskPdf = await desk.pg.request.get(`${BASE}/api/c/${slug}/prescriptions/${rxId}/pdf`);
    check("the desk may reprint one already written", deskPdf.status() === 200, String(deskPdf.status()));
    const out = await ctx(`outsider-${slug}@test.local`);
    const outPdf = await out.pg.request.get(`${BASE}/api/c/${slug}/prescriptions/${rxId}/pdf`);
    check("somebody who cannot open files cannot", outPdf.status() === 403, String(outPdf.status()));
    await out.c.close();

    /* ============================================================ the second time */
    console.log("\n[the second time is quicker]");
    await doc.pg.getByRole("button", { name: A.new, exact: true }).first().click();
    await dialog(doc.pg).waitFor();
    const nameB = doc.pg.getByRole("combobox", { name: A.medicineName }).first();
    await nameB.click();
    await nameB.pressSequentially("amo", { delay: 30 });
    const option = doc.pg.getByRole("option").filter({ hasText: "Amoxicillin 500mg" });
    check("the list suggests what the clinic prescribed before", (await option.count()) === 1);
    await option.click();
    check(
      "picking it fills the rest of the line the way it was written",
      (await doc.pg.getByRole("textbox", { name: A.dose }).first().inputValue()) === "كبسولة واحدة" &&
        (await doc.pg.getByRole("textbox", { name: A.duration }).first().inputValue()) === "7 أيام"
    );

    // Save as a template, for next time.
    await doc.pg.getByRole("button", { name: A.saveTemplate }).click();
    await doc.pg.getByRole("textbox", { name: A.templateName }).fill("التهاب حلق — بالغ");
    await doc.pg.getByRole("button", { name: ar.common.save, exact: true }).click();
    await doc.pg.getByRole("button", { name: "التهاب حلق — بالغ", exact: true }).waitFor({ timeout: 15_000 });
    check(
      "a template is saved from the prescription in hand",
      (await db.query(`select 1 from prescription_templates where clinic_id = $1`, [clinicId])).rowCount === 1
    );

    // Switched to English: the tapped answers come across.
    await doc.pg.getByRole("radio", { name: "English" }).click();
    check(
      "switching language translates the tapped answers",
      (await doc.pg.getByRole("textbox", { name: A.frequency }).first().inputValue()) === "3 times a day"
    );

    // Print: saved, rendered, opened in a tab — not sent.
    /*
      Watched as a request rather than as the tab's URL: headless Chromium has
      no PDF viewer and may take the file as a download, which leaves the tab
      itself on about:blank even though it went exactly where it should.
    */
    let pdfAsked = "";
    doc.c.on("request", (r) => {
      if (/\/prescriptions\/[0-9a-f-]+\/pdf/.test(r.url())) pdfAsked = r.url();
    });
    const popupP = doc.pg.waitForEvent("popup", { timeout: 90_000 });
    await doc.pg.getByRole("button", { name: A.print, exact: true }).click();
    const popup = await popupP;
    await dialog(doc.pg).waitFor({ state: "detached", timeout: 90_000 });
    await doc.pg.waitForTimeout(1500);
    check("print opens a tab and points it at the PDF", !!pdfAsked, pdfAsked || popup.url());
    await popup.close().catch(() => {});
    const rx2 = (await db.query(`select * from prescriptions where clinic_id = $1 and number = 2`, [clinicId])).rows[0];
    check("printing saves it", !!rx2);
    check("in English", rx2?.locale === "en");
    check("and does not send it", rx2?.message_id === null && rx2?.sent_at === null);
    check(
      "the list counted the second use",
      (await db.query(`select use_count from medications where clinic_id = $1`, [clinicId])).rows[0]?.use_count === 2
    );
    if (SHOTS) {
      const k2 = printKeyFor(rx2.id, "prescription");
      const s2 = await browser.newPage({ viewport: { width: 794, height: 1123 } });
      await s2.goto(`${BASE}/rx-print/${rx2.id}?kind=prescription&exp=${k2.exp}&sig=${k2.sig}`);
      await s2.waitForLoadState("networkidle");
      await s2.screenshot({ path: path.join(SHOTS, "rx-en.png"), fullPage: true });
      await s2.close();
    }

    /* ---- a template, in one tap */
    await doc.pg.getByRole("button", { name: A.new, exact: true }).first().click();
    await dialog(doc.pg).waitFor();
    await doc.pg.getByRole("button", { name: "التهاب حلق — بالغ", exact: true }).click();
    check(
      "a template fills the prescription in one tap",
      (await doc.pg.getByRole("combobox", { name: A.medicineName }).first().inputValue()) === "Amoxicillin 500mg"
    );
    // Something written, then Escape: asked before it is thrown away.
    await doc.pg.keyboard.press("Escape");
    const discard = doc.pg.getByRole("button", { name: A.discard, exact: true });
    check("closing with something written asks first", await discard.isVisible().catch(() => false));
    await discard.click();
    await dialog(doc.pg).first().waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});

    /* ---- Repeat */
    await openFile(doc.pg, patient, "prescriptions");
    await doc.pg.getByRole("button", { name: A.repeat, exact: true }).last().click();
    await dialog(doc.pg).waitFor();
    check(
      "Repeat opens the old prescription filled in",
      (await doc.pg.getByRole("combobox", { name: A.medicineName }).first().inputValue()) === "Amoxicillin 500mg" &&
        (await doc.pg.getByRole("textbox", { name: A.diagnosis }).inputValue()) === "التهاب حلق"
    );
    await doc.pg.keyboard.press("Escape");
    check(
      "and, unchanged, closes without a question",
      (await doc.pg.getByRole("button", { name: A.discard, exact: true }).count()) === 0
    );

    /* ---- Resend */
    const beforeMsgs = (await db.query(`select count(*)::int n from messages where clinic_id = $1`, [clinicId])).rows[0].n;
    await doc.pg.getByRole("button", { name: A.resend, exact: true }).last().click();
    await doc.pg.waitForFunction(
      () => !document.querySelector('button[aria-busy="true"]'),
      null,
      { timeout: 60_000 }
    );
    const afterMsgs = (await db.query(`select count(*)::int n from messages where clinic_id = $1`, [clinicId])).rows[0].n;
    check("Resend sends it again", afterMsgs === beforeMsgs + 1, `${beforeMsgs} → ${afterMsgs}`);

    /* ============================================================ the assistant */
    console.log("\n[an assistant writes one for the doctor]");
    const asst = await ctx(`assistant-${slug}@test.local`);
    await openFile(asst.pg, patient);
    await asst.pg.getByRole("button", { name: A.quickAction, exact: true }).click();
    await dialog(asst.pg).waitFor();
    // The prescriber is chosen once the clinic's list arrives.
    await asst.pg.waitForFunction(
      () => ((document.querySelector('[role="dialog"] select') as HTMLSelectElement | null)?.value ?? "").length > 30
    );
    const chosen = await asst.pg.locator('[role="dialog"] select').first().inputValue();
    check("the doctor who saw the patient is already chosen", chosen === doctorMember, chosen);
    await asst.pg.getByRole("combobox", { name: A.medicineName }).first().fill("Ibuprofen 400mg");
    await asst.pg.getByRole("button", { name: "عند الحاجة", exact: true }).click();
    await asst.pg.getByRole("button", { name: A.send, exact: true }).click();
    await dialog(asst.pg).waitFor({ state: "detached", timeout: 90_000 });
    const rx3 = (
      await db.query(`select * from prescriptions where clinic_id = $1 order by number desc limit 1`, [clinicId])
    ).rows[0];
    check("it is filed under the doctor", rx3?.doctor_member_id === doctorMember && rx3?.doctor_name === "د. سامي خليل");
    check("with the assistant as its author", rx3?.author_id === assistantId);
    check("and the doctor's signature", rx3?.signed === true);
    const note = (
      await db.query(
        `select title, body, url from notifications where user_id = $1 and kind = 'prescription_in_your_name'`,
        [doctorId]
      )
    ).rows[0];
    check("the doctor is told, in their language", !!note && note.title.includes("سارة المساعدة"), note?.title);
    check("with a link to the prescriptions", String(note?.url).endsWith(`/patients/${patient}?tab=prescriptions`), note?.url);
    const asstTab = (await asst.pg.locator("main").innerText()).replace(/\s+/g, " ");
    check("the list says who wrote it", asstTab.includes(A.writtenBy.replace("{name}", "سارة المساعدة")));
    await asst.c.close();

    /* ============================================================ the desk */
    console.log("\n[somebody who may read, not write]");
    await openFile(desk.pg, patient, "prescriptions");
    check("no Prescription button", (await desk.pg.getByRole("button", { name: A.quickAction, exact: true }).count()) === 0);
    const deskText = (await desk.pg.locator("main").innerText()).replace(/\s+/g, " ");
    check("but the prescriptions are in the file", deskText.includes("RX-0001"));
    check("with no Repeat or Resend", (await desk.pg.getByRole("button", { name: A.repeat }).count()) === 0 &&
      (await desk.pg.getByRole("button", { name: A.resend }).count()) === 0);
    await desk.c.close();

    /* ============================================================ no phone */
    console.log("\n[a patient with no number]");
    await openFile(doc.pg, noPhone);
    await doc.pg.getByRole("button", { name: A.quickAction, exact: true }).click();
    await dialog(doc.pg).waitFor();
    check("sending is not offered", await doc.pg.getByRole("button", { name: A.send, exact: true }).isDisabled());
    check("and the reason is said", (await dialog(doc.pg).innerText()).includes(A.noPhone));
    await doc.pg.keyboard.press("Escape");

    /* ============================================================ phone width */
    console.log("\n[on a phone]");
    const phone = await ctx(`doctor-${slug}@test.local`, { width: 390, height: 844 });
    await openFile(phone.pg, patient);
    await phone.pg.getByRole("button", { name: A.quickAction, exact: true }).click();
    await dialog(phone.pg).waitFor();
    await phone.pg.getByRole("combobox", { name: A.medicineName }).first().fill("Panadol 500mg");
    const overflow = await phone.pg.evaluate(() => {
      const d = document.querySelector('[role="dialog"]') as HTMLElement;
      return d.scrollWidth - d.clientWidth;
    });
    check("the composer does not scroll sideways", overflow <= 1, `${overflow}px`);
    if (SHOTS) await phone.pg.screenshot({ path: path.join(SHOTS, "composer-phone.png") });
    await phone.c.close();

    await doc.c.close();
  } finally {
    await browser.close();
  }

  await db.query(`delete from clinics where id = $1`, [clinicId]);
  await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
  await db.end();

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
