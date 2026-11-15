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
  const patient = (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Nada Haddad', '+962790771101', 'staff') returning id`, [clinic])).rows[0].id as string;
  const visit = await inRoom(clinic, patient, doc, consult, "Sore throat for three days");

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
