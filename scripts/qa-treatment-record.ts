/**
 * The treatment record, for every clinic (migration 0108).
 *
 * A clinic with no chart: the doctor, on a phone, with the patient in the
 * room, opens the visit's record from the banner — writes the complaint, the
 * examination and the diagnosis, confirms what the visit was booked for with
 * one tap, adds a treatment from the price list and one that is not on it,
 * takes a mis-tap back — and the Overview's Treatment card, the Appointments
 * tab and the Notes tab all say it. Reception finds it in Ready to bill at
 * the list's price, and an invoice raised from the visit bills what was
 * recorded once, not the booked service beside it.
 *
 * A clinic with the tooth chart: work recorded on the chart shows in the
 * record by itself, under its visit.
 *
 * A member who may not record sees the record and no way to write it.
 *
 * Second round (2026-11-15): the sheet has Back; a prescription written from
 * the record starts from its diagnosis, is filed under the visit and comes
 * back to the record; a file added there is filed under the visit (0109); a
 * treatment planned for later waits on the record and is offered first at
 * the next visit, with that visit's plan; the chart's tab offers the way
 * back to the record; and Talk fills the sections from speech, moving
 * between them by name.
 *
 * Third round (2026-11-15): Record visit for a patient with no appointment
 * today starts one (a walk-in, with the doctor) so the prescription and files
 * can be added; an appointment in the Appointments tab opens on all its
 * details, the invoice among them; a visit on the Treatment card leads to
 * them; and "New treatment" is the first thing offered.
 */
import { Client } from "pg";
import { chromium, devices, type Page } from "playwright";
import bcrypt from "bcryptjs";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";
const ALL_DAY = JSON.stringify(Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["00:00", "23:59"]]])));

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
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 90_000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const userIds: string[] = [];
  const clinicIds: string[] = [];

  const mkClinic = async (slug: string, name: string, features: Record<string, boolean>) => {
    const id = (
      await db.query(`insert into clinics (name, slug, timezone, working_hours, features) values ($1, $2, $3, $4, $5) returning id`, [name, slug, TZ, ALL_DAY, JSON.stringify(features)])
    ).rows[0].id as string;
    clinicIds.push(id);
    return id;
  };
  const mkUser = async (who: string, slug: string, name: string) => {
    const id = (
      await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [`${who}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name])
    ).rows[0].id as string;
    userIds.push(id);
    return id;
  };
  const member = async (clinic: string, user: string, role: string, permissions: unknown, owner = false) =>
    (
      await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, $3, $4, $5) returning id`, [clinic, user, role, owner, JSON.stringify(permissions)])
    ).rows[0].id as string;
  const inRoom = async (clinic: string, patient: string, doctor: string, service: string, notes = "") =>
    (
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, arrived_at, seated_at, notes)
         values ($1, $2, $3, $4, now() - interval '20 minutes', now() + interval '10 minutes', 'confirmed', now() - interval '20 minutes', now() - interval '18 minutes', $5) returning id`,
        [clinic, patient, doctor, service, notes]
      )
    ).rows[0].id as string;

  /* ── A clinic with no chart ─────────────────────────────────────────── */
  const slug = `qarec${tag}`;
  const clinic = await mkClinic(slug, "QA Record", { einvoicing: false });
  const deskUser = await mkUser("owner", slug, "QA Desk");
  await member(clinic, deskUser, "receptionist", { level: "full" }, true);
  const docUser = await mkUser("doc", slug, "Dr Rana");
  const doc = await member(clinic, docUser, "doctor", { level: "custom", caps: { dashboard: true, calendar: true, patients: true, "patients.prescriptions": true } });
  // Reads the file, may not record on it.
  const readerUser = await mkUser("reader", slug, "QA Reader");
  await member(clinic, readerUser, "receptionist", { level: "custom", caps: { dashboard: true, calendar: true, patients: true, "patients.charts": false } });
  const svc = async (name: string, price: number) =>
    (await db.query(`insert into services (clinic_id, name, duration_min, price) values ($1, $2, 30, $3) returning id`, [clinic, name, price])).rows[0].id as string;
  const consult = await svc("Consultation", 20);
  const dressing = await svc("Wound dressing", 8);
  await svc("Ear wash", 12);
  const earWash = (await db.query(`select id from services where clinic_id = $1 and name = 'Ear wash'`, [clinic])).rows[0].id as string;
  const patient = (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Nada Haddad', '+962790771101', 'staff') returning id`, [clinic])).rows[0].id as string;
  const visit = await inRoom(clinic, patient, doc, consult, "Sore throat for three days");

  // A follow-up: last week's visit left a plan and a treatment for later; today the patient is back.
  const sami = (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Sami Odeh', '+962790771103', 'staff') returning id`, [clinic])).rows[0].id as string;
  const lastWeek = (
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, now() - interval '7 days', now() - interval '7 days' + interval '30 minutes', 'completed') returning id`,
      [clinic, sami, doc, consult]
    )
  ).rows[0].id as string;
  await db.query(`insert into visit_records (clinic_id, patient_id, appointment_id, doctor_member_id, diagnosis, plan, recorded_by) values ($1, $2, $3, $4, 'Otitis externa', 'Drops for a week, then wash the ear', $5)`, [clinic, sami, lastWeek, doc, docUser]);
  const plannedWash = (
    await db.query(
      `insert into chart_marks (clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, status, recorded_by, fee, service_id, created_at)
       values ($1, $2, 'general', 'body', 'general', 'Ear wash', 'Ear wash', 'general', 'procedure', 'planned', $3, 12, $4, now() - interval '7 days') returning id`,
      [clinic, sami, docUser, earWash]
    )
  ).rows[0].id as string;
  const followUp = await inRoom(clinic, sami, doc, consult);
  // Seen today with no appointment at all.
  const lina = (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Lina Saleh', '+962790771104', 'staff') returning id`, [clinic])).rows[0].id as string;

  /* ── A clinic with the tooth chart ──────────────────────────────────── */
  const dslug = `qarecd${tag}`;
  const dclinic = await mkClinic(dslug, "QA Record Dental", { einvoicing: false, dental: true });
  const ddocUser = await mkUser("doc", dslug, "Dr Sami");
  const ddoc = await member(dclinic, ddocUser, "doctor", { level: "full" }, true);
  const dsvc = (await db.query(`insert into services (clinic_id, name, duration_min, price) values ($1, 'Check-up', 30, 15) returning id`, [dclinic])).rows[0].id as string;
  const dpatient = (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Omar Najjar', '+962790771102', 'staff') returning id`, [dclinic])).rows[0]
    .id as string;
  const dvisit = await inRoom(dclinic, dpatient, ddoc, dsvc);
  await db.query(
    `insert into chart_marks (clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status, performed_by, recorded_by, appointment_id, done_at)
     values ($1, $2, '36', 'extraction', 'Extraction', 'خلع', 'extraction', 'procedure', 'done', $3, $4, $5, now())`,
    [dclinic, dpatient, ddoc, ddocUser, dvisit]
  );

  const browser = await chromium.launch();
  const errors: string[] = [];
  const watch = (p: Page) => p.on("pageerror", (e) => errors.push(e.message));
  const base = `${BASE}/c/${slug}`;

  try {
    /* ============================================================ the doctor */
    console.log("\n[the doctor, on a phone, with the patient in the room]");
    const phoneCtx = await browser.newContext({ ...devices["iPhone 13"] });
    const ph = await phoneCtx.newPage();
    watch(ph);
    await signIn(ph, `doc-${slug}@test.local`);
    await ph.goto(`${base}/patients/${patient}`);
    await ph.waitForSelector('[data-visit-banner="in_room"]', { timeout: 90_000 });
    const card = ph.locator("[data-treatment-card]");
    await card.waitFor({ timeout: 30_000 });
    check("the Overview has a Treatment card, empty and saying so", (await card.innerText()).includes("Nothing recorded yet"), await card.innerText());
    const order = await ph.evaluate(`(() => {
      const m = document.querySelector("[data-overview] [data-medical-card], [data-overview] > div > div")?.getBoundingClientRect().top ?? 0;
      const t = document.querySelector("[data-treatment-card]").getBoundingClientRect().top;
      const forms = [...document.querySelectorAll("[data-overview] h3")].map((h) => h.getBoundingClientRect().top);
      return { m, t, last: Math.max(...forms) };
    })()`);
    check("on a phone it sits high in the file, above the details form", (order as { t: number; last: number }).t < (order as { t: number; last: number }).last, JSON.stringify(order));

    await ph.click("[data-visit-record-open]");
    await ph.waitForSelector(`[data-record-sheet="${visit}"]`, { timeout: 15_000 });
    await ph.waitForTimeout(600);
    const sheet = await ph.locator("[data-record-sheet] > div").last().boundingBox();
    const vh = ph.viewportSize()?.height ?? 0;
    check("the banner's Record visit opens the visit's record, rising from the bottom", !!sheet && Math.abs(sheet.y + sheet.height - vh) < 4, JSON.stringify(sheet));
    check("what was said at booking is beside the complaint", (await ph.locator("[data-record-booking]").innerText()).includes("Sore throat for three days"));

    await ph.fill('[data-record-input="complaint"]', "Sore throat, fever at night");
    await ph.fill('[data-record-input="exam"]', "Tonsils enlarged with exudate");
    await ph.fill('[data-record-input="diagnosis"]', "Acute tonsillitis");
    await ph.fill('[data-record-input="plan"]', "Fluids and rest, review in a week");

    const bookedChip = ph.locator(`[data-add-booked="${consult}"]`);
    check("the booked service is offered first", (await bookedChip.count()) === 1 && (await bookedChip.innerText()).includes("Consultation"));
    const chipBox = await bookedChip.boundingBox();
    check("as a chip big enough for a thumb", (chipBox?.height ?? 0) >= 40, String(chipBox?.height));
    await bookedChip.click();
    check("one tap records it as done, with the list's price", await until(async () => (await ph.locator("[data-done-line]").first().innerText()).includes("Consultation")));
    check("and it is offered no more", (await ph.locator(`[data-add-booked="${consult}"]`).count()) === 0);

    await ph.click("[data-record-pick]");
    await ph.fill("[data-record-search]", "dress");
    await ph.click(`[data-add-service="${dressing}"]`);
    check("a treatment is added from the price list by searching it", await until(async () => (await ph.locator("[data-done-line]").count()) === 2));
    await ph.fill("[data-record-search]", "Throat swab");
    await ph.click("[data-add-other]");
    check("and one that is not on the list, by its name", await until(async () => (await ph.locator("[data-done-line]").count()) === 3));
    const lines = () => ph.locator("[data-record-done-edit]").innerText();
    check("which has no price", (await lines()).includes("No price"), await lines());

    // A mis-tap: taken back whole inside two minutes.
    const dressRow = (await db.query(`select id from chart_marks where patient_id = $1 and service_id = $2`, [patient, dressing])).rows[0];
    check("the dressing is stored as a treatment no chart draws", await until(async () => (await db.query(`select 1 from chart_marks where patient_id = $1 and service_id = $2 and chart = 'general'`, [patient, dressing])).rowCount === 1), JSON.stringify(dressRow));
    const dressId = (await db.query(`select id from chart_marks where patient_id = $1 and service_id = $2`, [patient, dressing])).rows[0].id as string;
    await ph.click(`[data-done-remove="${dressId}"]`);
    check("Remove takes a mis-tap back whole", await until(async () => (await db.query(`select 1 from chart_marks where id = $1`, [dressId])).rowCount === 0));

    check("the text is saved as it is typed", await until(async () => (await ph.locator("[data-record-save]").getAttribute("data-record-save")) === "saved", 30_000));
    await ph.click("[data-record-close]");
    await ph.locator("[data-record-sheet]").waitFor({ state: "detached" });

    const rec = (await db.query(`select * from visit_records where patient_id = $1`, [patient])).rows;
    check(
      "the visit has one record, with what was written",
      rec.length === 1 && rec[0].appointment_id === visit && rec[0].complaint === "Sore throat, fever at night" && rec[0].exam === "Tonsils enlarged with exudate" && rec[0].diagnosis === "Acute tonsillitis" && rec[0].plan === "Fluids and rest, review in a week",
      JSON.stringify(rec)
    );
    check("filed under the visit's doctor, by who wrote it", rec[0]?.doctor_member_id === doc && rec[0]?.recorded_by === docUser);
    const versions = (await db.query(`select count(*)::int as n from visit_record_versions where record_id = $1`, [rec[0]?.id])).rows[0].n;
    check("one sitting is one version, however many pauses", versions === 1, String(versions));
    const marks = (await db.query(`select label, fee, service_id, appointment_id, performed_by, status, chart, site from chart_marks where patient_id = $1 and voided_at is null order by created_at`, [patient])).rows;
    check(
      "the treatments are done at the visit, by its doctor: the consultation at the list's price, the swab at none",
      marks.length === 2 &&
        marks[0].label === "Consultation" && Number(marks[0].fee) === 20 && marks[0].service_id === consult &&
        marks[1].label === "Throat swab" && marks[1].fee === null && marks[1].service_id === null &&
        marks.every((m) => m.appointment_id === visit && m.performed_by === doc && m.status === "done" && m.chart === "general" && m.site === "body"),
      JSON.stringify(marks)
    );

    const said = await card.innerText();
    check("the card shows the visit: the diagnosis", said.includes("Acute tonsillitis"), said);
    check("the complaint, the examination and the plan", said.includes("Sore throat, fever at night") && said.includes("Tonsils enlarged with exudate") && said.includes("Fluids and rest"), said);
    check("and what was done", said.includes("Consultation") && said.includes("Throat swab") && !said.includes("Wound dressing"), said);
    const sideways = (await ph.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
    check("nothing on the phone scrolls sideways", sideways <= 0, String(sideways));

    await ph.reload();
    await ph.waitForSelector("[data-treatment-entry]", { timeout: 60_000 });
    check("it is all there when the file is opened again", (await ph.locator("[data-treatment-card]").innerText()).includes("Acute tonsillitis"));

    // Opened again, the record is the same one: edited, not doubled.
    await ph.click("[data-entry-edit]");
    await ph.waitForSelector(`[data-record-sheet="${visit}"]`);
    check("Edit opens the same record", (await ph.inputValue('[data-record-input="diagnosis"]')) === "Acute tonsillitis");
    await ph.fill('[data-record-input="diagnosis"]', "Acute bacterial tonsillitis");
    check("and saves the change", await until(async () => (await ph.locator("[data-record-save]").getAttribute("data-record-save")) === "saved", 30_000));
    await ph.click("[data-record-close]");
    const again = (await db.query(`select diagnosis from visit_records where patient_id = $1`, [patient])).rows;
    check("on the one record", again.length === 1 && again[0].diagnosis === "Acute bacterial tonsillitis", JSON.stringify(again));

    console.log("\n[everything the visit produces, from its record]");
    await ph.click("[data-entry-edit]");
    await ph.waitForSelector(`[data-record-sheet="${visit}"]`);
    await ph.click("[data-record-back]");
    check("Back closes the sheet onto the file", await until(async () => (await ph.locator("[data-record-sheet]").count()) === 0));
    await ph.click("[data-entry-edit]");
    await ph.waitForSelector(`[data-record-sheet="${visit}"]`);

    // A treatment for later.
    await ph.click("[data-record-plan-pick]");
    await ph.click("[data-picker-back]");
    check("the price list has a Back of its own", (await ph.locator("[data-record-picker]").count()) === 0 && (await ph.locator("[data-record-plan-pick]").count()) === 1);
    check("“New treatment” is the first thing offered for what was done", (await ph.locator("[data-record-pick]").innerText()).includes("New treatment"));
    await ph.click("[data-record-plan-pick]");
    await ph.click(`[data-add-service="${earWash}"]`);
    check("a treatment is planned for a later visit", await until(async () => (await ph.locator("[data-planned-line]").count()) === 1));
    const planRow = await until(async () => (await db.query(`select 1 from chart_marks where patient_id = $1 and service_id = $2 and status = 'planned' and appointment_id is null and done_at is null`, [patient, earWash])).rowCount === 1);
    check("stored as planned, at no visit yet", planRow);

    // A photo, added to the visit.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await ph.setInputFiles("[data-record-file-input]", { name: "throat.png", mimeType: "image/png", buffer: png });
    check("a photo added from the record shows under it", await until(async () => (await ph.locator("[data-record-file]").count()) === 1, 30_000));
    const fileRow = (await db.query(`select appointment_id, kind from patient_files where patient_id = $1`, [patient])).rows;
    check("and is filed under the visit", fileRow.length === 1 && fileRow[0].appointment_id === visit && fileRow[0].kind === "photo", JSON.stringify(fileRow));

    // A prescription, from the record and back to it.
    await ph.click("[data-record-prescribe]");
    await ph.getByRole("combobox", { name: "Medicine" }).first().waitFor({ timeout: 30_000 });
    check("Write a prescription opens it in place of the sheet", (await ph.locator("[data-record-sheet]").count()) === 0);
    await ph.getByRole("combobox", { name: "Medicine" }).first().fill("Amoxicillin 500mg");
    await ph.getByRole("button", { name: "Send on WhatsApp", exact: true }).click();
    check("and sending it comes back to the record", await until(async () => (await ph.locator(`[data-record-sheet="${visit}"]`).count()) === 1, 90_000));
    const rxRow = (await db.query(`select appointment_id, diagnosis from prescriptions where patient_id = $1`, [patient])).rows;
    check("the prescription is filed under the visit, starting from its diagnosis", rxRow.length === 1 && rxRow[0].appointment_id === visit && rxRow[0].diagnosis === "Acute bacterial tonsillitis", JSON.stringify(rxRow));
    check("and listed in the record", await until(async () => (await ph.locator("[data-record-rx]").count()) === 1) && (await ph.locator("[data-record-rx]").innerText()).includes("Amoxicillin"));
    check("the diagnosis written before is still there", (await ph.inputValue('[data-record-input="diagnosis"]')) === "Acute bacterial tonsillitis");
    await ph.click("[data-record-close]");
    await ph.locator("[data-record-sheet]").waitFor({ state: "detached" });
    const cardNow = await ph.locator("[data-treatment-card]").innerText();
    check("the card shows the visit's prescription and photo", cardNow.includes("Amoxicillin") && cardNow.includes("throat.png"), cardNow);
    check("and what is planned for later, apart from what was done", (await ph.locator("[data-treatment-planned]").innerText()).includes("Ear wash"), cardNow);
    await ph.click(`[data-entry-appointment="${visit}"]`);
    const detailsFromCard = ph.locator(`[data-appointment-details="${visit}"]`);
    check("a visit on the card leads to its appointment, opened, in the Appointments tab", await until(async () => (await detailsFromCard.count()) === 1));
    const fromCard = await detailsFromCard.innerText();
    check("which shows the day: arrived, with the doctor", fromCard.includes("Arrived") && fromCard.includes("with the doctor"), fromCard);
    check("and the visit's record, prescription and photo", fromCard.includes("Acute bacterial tonsillitis") && fromCard.includes("Amoxicillin") && fromCard.includes("throat.png"), fromCard);
    check("with a tooth, not a face, nowhere here (no chart in this clinic)", (await ph.locator("[data-visit-work-count]").count()) === 0);
    await ph.goto(`${base}/patients/${patient}`);
    await ph.waitForSelector("[data-treatment-card]", { timeout: 60_000 });

    console.log("\n[the same visit, elsewhere in the file]");
    await ph.goto(`${base}/patients/${patient}?tab=notes`);
    const feed = ph.locator('[data-feed-source="treatment"]').first();
    await feed.waitFor({ timeout: 60_000 });
    const feedText = await feed.innerText();
    check("the Notes tab has it, from Treatment", feedText.includes("Treatment") && feedText.includes("Diagnosis: Acute bacterial tonsillitis"), feedText);
    await ph.goto(`${base}/patients/${patient}?tab=appointments`);
    const row = ph.locator(`[data-appointment-row="${visit}"]`);
    await row.waitFor({ timeout: 60_000 });
    check("the visit's row says something was recorded", (await row.locator("[data-visit-recorded]").count()) === 1);
    await row.locator("button").first().click();
    const inRow = await row.locator("[data-appointment-record]").innerText();
    check("and opens to the same record", inRow.includes("Acute bacterial tonsillitis") && inRow.includes("Consultation"), inRow);
    check("no page errors on the phone", errors.length === 0, errors.join(" | "));
    await phoneCtx.close();

    /* ============================================================ reception */
    console.log("\n[reception bills it]");
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(desk);
    await signIn(desk, `owner-${slug}@test.local`);
    await desk.goto(`${base}/invoices`);
    await desk.waitForSelector("[data-ready-desk]", { timeout: 90_000 });
    if ((await desk.locator("[data-ready-desk]").getAttribute("data-ready-open")) !== "true") await desk.click("[data-ready-toggle]");
    await desk.locator("[data-desk-expand]").first().click();
    const deskLines = await desk.locator("[data-desk-lines]").innerText();
    check("Ready to bill has the patient, in a clinic with no chart", deskLines.includes("Consultation") && deskLines.includes("Throat swab"), deskLines);
    check("the consultation at the list's price, by the doctor who did it", deskLines.includes("20") && deskLines.includes("Dr Rana"), deskLines);
    check("named as a treatment, not a tooth", deskLines.includes("Treatment") && !deskLines.includes("Dental"), deskLines);
    check("what is only planned is not there to bill", !deskLines.includes("Ear wash"), deskLines);

    const lineValues = (p: Page) => p.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    await desk.goto(`${base}/invoices/new?patient=${patient}&appointment=${visit}`, { timeout: 120_000 });
    check("an invoice from the visit starts from what was recorded", await until(async () => (await lineValues(desk)).includes("Throat swab"), 60_000), JSON.stringify(await lineValues(desk)));
    const vals = await lineValues(desk);
    check("the consultation once — not the booked service beside it", vals.filter((v) => v === "Consultation").length === 1, JSON.stringify(vals));
    await desk.getByRole("button", { name: "Create", exact: true }).click();
    await desk.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    const billedRows = (await db.query(`select count(*)::int as n from invoice_item_marks iim join chart_marks m on m.id = iim.mark_id where m.patient_id = $1`, [patient])).rows[0].n;
    check("the invoice's lines are tied to the treatments", billedRows === 2, String(billedRows));
    await desk.goto(`${base}/invoices`);
    await desk.waitForSelector("main", { timeout: 60_000 });
    check("billed, they leave Ready to bill", await until(async () => (await desk.locator("[data-ready-desk]").count()) === 0, 20_000));
    const invNo = (await db.query(`select number from invoices where patient_id = $1 and appointment_id = $2`, [patient, visit])).rows[0]?.number as string | undefined;
    await desk.goto(`${base}/patients/${patient}?tab=appointments`);
    const deskRow = desk.locator(`[data-appointment-row="${visit}"]`);
    await deskRow.waitFor({ timeout: 60_000 });
    check("the visit's row says it is invoiced", !!invNo && (await deskRow.locator("[data-visit-invoiced]").innerText()).includes(invNo), invNo);
    await deskRow.locator("button").first().click();
    const details = await deskRow.locator("[data-appointment-details]").innerText();
    check("opened, it shows the appointment's details: when, doctor, the day at the clinic", details.includes("When") && details.includes("Dr Rana") && details.includes("Arrived"), details);
    check("what was said when booking", details.includes("Sore throat for three days"), details);
    check("and its invoice, with its total and status", !!invNo && details.includes(invNo) && /Draft|Sent|Paid/.test(details), details);
    check("and a way to it in the calendar", (await deskRow.locator("[data-detail-calendar]").getAttribute("href"))?.endsWith(`?open=${visit}`));

    // A second treatment after the invoice: the patient's Invoices tab offers it.
    await db.query(
      `insert into chart_marks (clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, status, performed_by, recorded_by, appointment_id, done_at, fee, service_id)
       values ($1, $2, 'general', 'body', 'general', 'Wound dressing', 'Wound dressing', 'general', 'procedure', 'done', $3, $4, $5, now(), 8, $6)`,
      [clinic, patient, doc, docUser, visit, dressing]
    );
    await desk.goto(`${base}/patients/${patient}?tab=invoices`);
    const billing = desk.locator("[data-treatment-billing]");
    await billing.waitFor({ timeout: 60_000 });
    const billingText = await billing.innerText();
    check("the patient's Invoices tab offers what is not billed yet, and only that", billingText.includes("Wound dressing") && !billingText.includes("Consultation"), billingText);
    check("with a Bill button for it", (await desk.locator("[data-treatment-bill]").innerText()).includes("Bill 1"));
    await desk.close();

    /* ============================================================ the follow-up */
    console.log("\n[the next visit picks up the plan]");
    // A recognition that hears what the test says: the browser's own cannot be driven.
    const talkCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await talkCtx.addInitScript(`
      window.SpeechRecognition = class {
        constructor() { window.__rec = this; }
        start() { window.__recOn = true; }
        stop() { window.__recOn = false; if (this.onend) this.onend(); }
        abort() { window.__recOn = false; }
      };
      window.__say = (text) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    `);
    const fu = await talkCtx.newPage();
    watch(fu);
    await signIn(fu, `doc-${slug}@test.local`);
    await fu.goto(`${base}/patients/${sami}`);
    await fu.waitForSelector("[data-treatment-card]", { timeout: 90_000 });
    const top = (await fu.evaluate(`(() => {
      const t = document.querySelector("[data-treatment-card]").getBoundingClientRect().top;
      const h = [...document.querySelectorAll("[data-overview] h3")].find((x) => x.innerText.includes("Medical history"));
      return { t, m: h ? h.getBoundingClientRect().top : -1 };
    })()`)) as { t: number; m: number };
    check("the Treatment card is above the medical history", top.m > 0 && top.t < top.m, JSON.stringify(top));
    check("the card says what is planned", (await fu.locator("[data-treatment-planned]").innerText()).includes("Ear wash"));
    await fu.click("[data-visit-record-open]");
    await fu.waitForSelector(`[data-record-sheet="${followUp}"]`);
    const lastPlan = await fu.locator("[data-record-last-plan]").innerText();
    check("the sheet opens on last visit's plan", lastPlan.includes("Drops for a week, then wash the ear"), lastPlan);
    check("and offers what was planned first", (await fu.locator(`[data-finish-planned="${plannedWash}"]`).count()) === 1);
    await fu.click(`[data-finish-planned="${plannedWash}"]`);
    const washed = await until(async () => {
      const r = (await db.query(`select status, appointment_id, done_at, performed_by from chart_marks where id = $1`, [plannedWash])).rows[0];
      return r.status === "done" && r.appointment_id === followUp && r.done_at !== null && r.performed_by === doc;
    });
    check("one tap marks it done at this visit, by its doctor", washed);
    check("it moves to Done and is planned no more", (await fu.locator("[data-done-line]").count()) === 1 && (await fu.locator("[data-planned-line]").count()) === 0);

    // Talk.
    check("Talk is offered where the browser can listen", (await fu.locator("[data-talk-toggle]").count()) === 1);
    await fu.click('[data-talk-lang="en"]');
    await fu.click("[data-talk-toggle]");
    check("it listens", (await fu.locator("[data-record-talk]").getAttribute("data-record-talk")) === "on" && (await fu.evaluate("window.__recOn")) === true);
    await fu.evaluate(`window.__say("ear still blocked on the right")`);
    await fu.evaluate(`window.__say("examination canal clear after washing diagnosis otitis externa resolved")`);
    await fu.evaluate(`window.__say("plan no further visit needed")`);
    await fu.evaluate(`window.__say("the patient plans to travel")`);
    const heard = async (f: string) => fu.inputValue(`[data-record-input="${f}"]`);
    check("what is said goes to the open section", (await heard("complaint")) === "ear still blocked on the right", await heard("complaint"));
    check("a section's name moves to it, mid-sentence", (await heard("exam")) === "canal clear after washing" && (await heard("diagnosis")) === "otitis externa resolved", `${await heard("exam")} | ${await heard("diagnosis")}`);
    check("“plan” as a heading moves; as a word it is only a word", (await heard("plan")) === "no further visit needed the patient plans to travel", await heard("plan"));
    await fu.click('[data-talk-lang="ar"]');
    await fu.evaluate(`window.__say("الشكوى ألم خفيف")`);
    check("and in Arabic", (await heard("complaint")) === "ear still blocked on the right ألم خفيف", await heard("complaint"));
    await fu.click("[data-talk-toggle]");
    check("Stop stops listening", (await fu.locator("[data-record-talk]").getAttribute("data-record-talk")) === "off");
    check("what was said is saved like typed text", await until(async () => (await db.query(`select diagnosis from visit_records where appointment_id = $1`, [followUp])).rows[0]?.diagnosis === "otitis externa resolved", 30_000));
    await fu.click("[data-record-close]");

    await fu.click("[data-visit-finish]");
    await fu.waitForSelector("[data-finish-sheet]", { timeout: 15_000 });
    const handed = await fu.locator("[data-finish-recorded]").innerText();
    check("Finish shows what was done and the plan, to choose the next visit by", handed.includes("Ear wash") && handed.includes("no further visit needed"), handed);
    await fu.keyboard.press("Escape");
    await talkCtx.close();

    /* ============================================================ no appointment */
    console.log("\n[a patient seen with no appointment]");
    const walkCtx = await browser.newContext({ ...devices["iPhone 13"] });
    const wk = await walkCtx.newPage();
    watch(wk);
    await signIn(wk, `doc-${slug}@test.local`);
    await wk.goto(`${base}/patients/${lina}`);
    await wk.waitForSelector("[data-treatment-record]", { timeout: 90_000 });
    check("no visit, no banner", (await wk.locator("[data-visit-banner]").count()) === 0);
    await wk.click("[data-treatment-record]");
    const walkIn = await until(async () => (await db.query(`select 1 from appointments where patient_id = $1`, [lina])).rowCount === 1, 30_000);
    const appt = (await db.query(`select id, walk_in, arrived_at, seated_at, doctor_member_id, status, created_by from appointments where patient_id = $1`, [lina])).rows[0];
    check("Record visit starts a visit for now: a walk-in, with the doctor, already in the room", walkIn && appt.walk_in && appt.arrived_at && appt.seated_at && appt.doctor_member_id === doc && appt.status === "confirmed" && appt.created_by === docUser, JSON.stringify(appt));
    check("and the sheet opens on it", await until(async () => (await wk.locator(`[data-record-sheet="${appt?.id}"]`).count()) === 1));
    check("with the prescription and the files to add", (await wk.locator("[data-record-prescribe]").count()) === 1 && (await wk.locator("[data-record-add-file]").count()) === 1);
    await wk.setInputFiles("[data-record-file-input]", { name: "rash.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
    check("a photo goes under the new visit", await until(async () => (await db.query(`select 1 from patient_files where patient_id = $1 and appointment_id = $2`, [lina, appt?.id])).rowCount === 1, 30_000));
    const told = (await db.query(`select count(*)::int as n from notifications where clinic_id = $1 and kind like '%appointment%'`, [clinic])).rows[0].n;
    check("nobody is told an appointment was booked", told === 0, String(told));
    await wk.click("[data-record-close]");
    check("the file now shows the visit in progress", await until(async () => (await wk.locator('[data-visit-banner="in_room"]').count()) === 1, 30_000));
    await walkCtx.close();

    /* ============================================================ may not record */
    console.log("\n[a member who may not record]");
    const reader = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(reader);
    await signIn(reader, `reader-${slug}@test.local`);
    await reader.goto(`${base}/patients/${patient}`);
    await reader.waitForSelector("[data-treatment-card]", { timeout: 90_000 });
    check("reads the record", (await reader.locator("[data-treatment-card]").innerText()).includes("Acute bacterial tonsillitis"));
    check("and is offered no way to write it", (await reader.locator("[data-treatment-record], [data-entry-edit], [data-visit-record-open]").count()) === 0);
    const refused = await reader.evaluate(`fetch("/api/c/${slug}/patients/${patient}/treatment/marks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), eventId: crypto.randomUUID(), label: "Sneaked in" }) }).then((r) => r.status)`);
    check("the route refuses them too", refused === 403, String(refused));
    const refusedRecord = await reader.evaluate(`fetch("/api/c/${slug}/patients/${patient}/treatment/records/" + crypto.randomUUID(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: { diagnosis: "x" } }) }).then((r) => r.status)`);
    check("and the record's", refusedRecord === 403, String(refusedRecord));
    await reader.close();

    /* ============================================================ a chart clinic */
    console.log("\n[a clinic with the tooth chart]");
    const dent = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(dent);
    await signIn(dent, `doc-${dslug}@test.local`);
    await dent.goto(`${BASE}/c/${dslug}/patients/${dpatient}`);
    const dcard = dent.locator("[data-treatment-card]");
    await dcard.waitFor({ timeout: 90_000 });
    check("tooth work shows in the record by itself, under its visit", await until(async () => (await dcard.locator("[data-record-dental]").count()) === 1, 30_000), await dcard.innerText());
    const dtext = await dcard.innerText();
    check("as the chart names it", dtext.includes("Extraction") && dtext.includes("36"), dtext);
    await dent.click("[data-visit-record-open]");
    await dent.waitForSelector(`[data-record-sheet="${dvisit}"]`);
    const charts = await dent.locator("[data-record-charts]").innerText();
    check("the sheet points to the chart instead of taking tooth work", charts.includes("Open the tooth chart") && charts.includes("1 done"), charts);
    await dent.click('[data-open-chart="dental"]');
    check("and opens it", await until(async () => new URL(dent.url()).pathname.endsWith(dpatient) && (await dent.locator("[data-record-sheet]").count()) === 0));
    check("the chart's tab offers the way back to the record", await until(async () => (await dent.locator("[data-back-to-record]").count()) === 1));
    await dent.click("[data-back-to-record] button");
    check("and it opens the same visit's record again", await until(async () => (await dent.locator(`[data-record-sheet="${dvisit}"]`).count()) === 1));
    await dent.click("[data-record-back]");
    const none = (await db.query(`select count(*)::int as n from chart_marks where patient_id = $1 and chart = 'general'`, [dpatient])).rows[0].n;
    check("nothing was entered twice", none === 0, String(none));
    await dent.close();

    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    for (const id of clinicIds) await db.query(`delete from clinics where id = $1`, [id]).catch((e) => console.log("cleanup:", e.message));
    await db.query(`delete from users where id = any($1::uuid[])`, [userIds]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
