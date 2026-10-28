/**
 * The face chart (0084): aesthetic work on the face, billed like the dental chart.
 *
 * Yamen, 2026-10-28: tap the area, choose the treatment, and reception sees
 * what to bill; only clinics he switches it on for; the face only for now.
 *
 * - The gate: `aesthetic` is opt-in and switched on for nobody; without it the
 *   tab, the routes and Settings → Face treatment prices are gone. An
 *   aesthetic clinic without the dental chart cannot write teeth; a dental
 *   clinic without the face chart cannot write faces.
 * - The chart: Upper face, Botulinum toxin, units per area, Save — stored as
 *   one treatment of 3 areas and 54 units; a filler by the syringe.
 * - Prices: set in Settings, the toxin waiting without one takes it (3 × 70).
 * - Billing: Ready to bill on the tab, the desk's Ready to bill, the invoice
 *   builder's words, the invoice linked, the doctor's share on the line.
 * - Changes: price by hand, void, the two-minute undo; a medical centre's
 *   dental chart never reads its face work.
 *
 * Run against a warm server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

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
async function until(fn: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);

  /** A clinic with one owner doctor (40%, shared deal) and one patient. */
  const makeClinic = async (name: string, features: Record<string, boolean>) => {
    const slug = `qaface${name.toLowerCase()}${tag}`;
    const [clinic] = await q(`insert into clinics (name, slug, specialty, features) values ($1, $2, 'dermatology', $3) returning id`, [
      `QA Face ${name}`,
      slug,
      JSON.stringify(features),
    ]);
    await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
    const email = `face-${name.toLowerCase()}-${tag}@test.local`;
    const [user] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, hash, `Dr ${name}`]);
    const [doc] = await q(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions, commission_percent)
       values ($1, $2, 'doctor', true, 'Dr.', '{"level":"full"}', 40) returning id`,
      [clinic.id, user.id]
    );
    const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Lina Face', $2, 'staff') returning id`, [
      clinic.id,
      `+96279${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    ]);
    return { id: clinic.id as string, slug, email, userId: user.id as string, docId: doc.id as string, patientId: patient.id as string };
  };

  const face = await makeClinic("Aes", { aesthetic: true });
  const plain = await makeClinic("Plain", {});
  const dental = await makeClinic("Dent", { dental: true });
  const centre = await makeClinic("Both", { dental: true, aesthetic: true });

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    /* ── The gate ───────────────────────────────────────────────────── */
    console.log("The gate");
    const pp = await signIn(browser, plain.email);
    pp.on("pageerror", (e) => errors.push(e.message));
    const plainFace = await pp.request.get(`${BASE}/api/c/${plain.slug}/patients/${plain.patientId}/face`);
    check(plainFace.status() === 403, "a clinic without the face chart cannot read one", String(plainFace.status()));
    const plainPost = await pp.request.post(`${BASE}/api/c/${plain.slug}/patients/${plain.patientId}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "forehead", units: 10 }] },
    });
    check(plainPost.status() === 403, "nor record on one", String(plainPost.status()));
    await pp.goto(`${BASE}/c/${plain.slug}/patients/${plain.patientId}`, { timeout: 180000 });
    await pp.waitForSelector("main", { timeout: 60000 });
    check(!(await pp.locator("main").innerText()).includes("Face chart"), "and its patient files have no Face chart tab");
    await pp.goto(`${BASE}/c/${plain.slug}/settings/face-prices`, { timeout: 120000 });
    check(await until(async () => pp.url().includes("/settings/services"), 30000), "Settings → Face treatment prices sends it to Services");
    await pp.context().close();

    const dp = await signIn(browser, dental.email);
    const dentFace = await dp.request.post(`${BASE}/api/c/${dental.slug}/patients/${dental.patientId}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "forehead", units: 10 }] },
    });
    check(dentFace.status() === 403, "a dental clinic cannot record on a face", String(dentFace.status()));
    const dentTooth = await dp.request.post(`${BASE}/api/c/${dental.slug}/patients/${dental.patientId}/dental/marks`, {
      data: { marks: [{ id: crypto.randomUUID(), eventId: crypto.randomUUID(), site: "16", treatmentKey: "caries", surfaces: ["O"], status: "existing" }] },
    });
    check(dentTooth.status() === 200, "and still records on teeth as before", String(dentTooth.status()));
    await dp.context().close();

    /* ── An aesthetic clinic ────────────────────────────────────────── */
    console.log("An aesthetic clinic");
    const page = await signIn(browser, face.email);
    page.on("pageerror", (e) => errors.push(e.message));
    const tooth = await page.request.post(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/dental/marks`, {
      data: { marks: [{ id: crypto.randomUUID(), eventId: crypto.randomUUID(), site: "16", treatmentKey: "caries", surfaces: ["O"], status: "existing" }] },
    });
    check(tooth.status() === 403, "without the dental chart it cannot write a tooth, though it may record on charts", String(tooth.status()));
    const badArea = await page.request.post(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "cheek_r", units: 10 }] },
    });
    check(badArea.status() === 400, "a toxin on the cheek is refused: the catalog says where each treatment is done", String(badArea.status()));

    const fileUrl = `${BASE}/c/${face.slug}/patients/${face.patientId}?tab=face`;
    await page.goto(fileUrl, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    check((await page.locator("main").innerText()).includes("Face chart"), "the patient file has the Face chart tab");
    check(
      await until(async () => (await page.locator("[data-face-map] img").evaluate((i) => (i as HTMLImageElement).naturalWidth)) > 0),
      "and the face picture loads"
    );
    check((await page.locator("[data-zone]").count()) === 21, "21 parts of the face to tap", String(await page.locator("[data-zone]").count()));

    // Upper face, one tap; the toxin is offered and the filler is not.
    await page.locator("[data-face-preset='upper']").click();
    await page.waitForSelector("[data-face-panel='areas']", { timeout: 10000 });
    check((await page.locator("[data-zone][aria-pressed='true']").count()) === 4, "Upper face selects forehead, glabella and both crow's feet");
    check((await page.locator("[data-face-treatment='aes_toxin']").count()) === 1, "Botulinum toxin fits all four");
    check((await page.locator("[data-face-treatment='aes_filler']").count()) === 0, "a filler does not");
    await page.locator("[data-face-treatment='aes_toxin']").click();
    await page.waitForSelector("[data-face-panel='record']", { timeout: 10000 });
    check((await page.locator("[data-face-panel='record']").innerText()).includes("54u in total"), "units start where they usually do: 10 + 20 + 12 + 12 = 54");
    check((await page.locator("[data-face-panel='record']").innerText()).includes("No price on the list yet"), "no price on the list yet, and it says so");
    await page.locator("[data-face-doer]").selectOption(face.docId);
    await page.locator("[data-face-save]").click();
    const marksOf = async (clinicId: string, key: string) =>
      q(`select *, fee::float as fee, quantity::float as quantity from chart_marks where clinic_id = $1 and treatment_key = $2 order by created_at`, [clinicId, key]);
    check(await until(async () => (await marksOf(face.id, "aes_toxin")).length === 1), "Save stores the treatment");
    const [toxin] = await marksOf(face.id, "aes_toxin");
    const units = Object.fromEntries((toxin.areas as { zone: string; units: number }[]).map((a) => [a.zone, a.units]));
    check(
      toxin.chart === "aesthetic" && toxin.site === "face" && toxin.status === "done" && toxin.kind === "procedure" && toxin.performed_by === face.docId,
      "as face work, done, by the doctor",
      JSON.stringify({ chart: toxin.chart, site: toxin.site, status: toxin.status })
    );
    check(units.forehead === 10 && units.glabella === 20 && units.crows_r === 12 && units.crows_l === 12, "with the units on each area", JSON.stringify(units));
    check(toxin.quantity === 3 && toxin.fee === null, "priced by the area: 3 areas (both crow's feet are one), no price yet", JSON.stringify({ q: toxin.quantity, fee: toxin.fee }));
    check(await until(async () => (await page.locator(`[data-face-entry='${toxin.id}']`).count()) > 0), "it is in the history at once");
    check((await page.locator("[data-zone='forehead'] span span").count()) === 1, "and the forehead carries a toxin dot");

    /* ── Prices ─────────────────────────────────────────────────────── */
    console.log("Prices");
    await page.goto(`${BASE}/c/${face.slug}/settings/face-prices`, { timeout: 120000 });
    await page.waitForSelector("[data-face-prices]", { timeout: 60000 });
    check((await page.locator("nav a", { hasText: "Face treatment prices" }).count()) > 0, "Face treatment prices has its place in Settings");
    check((await page.locator("[data-face-price-row='aes_toxin']").innerText()).includes("1 recorded with no price"), "the toxin says one was recorded with no price");
    const toxinBox = page.locator("[data-price-box='aes_toxin']");
    await toxinBox.fill("70");
    await toxinBox.press("Enter");
    check(
      await until(async () => (await q(`select price::float as p, chart_owned from services where clinic_id = $1 and chart_key = 'aes_toxin' and active`, [face.id]))[0]?.p === 70),
      "a price of 70 an area makes the toxin's service"
    );
    check(await until(async () => (await marksOf(face.id, "aes_toxin"))[0].fee === 210), "and the toxin waiting takes it: 3 areas × 70 = 210");
    const fillerBox = page.locator("[data-price-box='aes_filler']");
    await fillerBox.fill("150");
    await fillerBox.press("Enter");
    check(await until(async () => (await q(`select 1 from services where clinic_id = $1 and chart_key = 'aes_filler' and price = 150`, [face.id])).length === 1), "a filler at 150 a syringe");

    /* ── A filler by the syringe ────────────────────────────────────── */
    console.log("A filler");
    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-face-map]", { timeout: 60000 });
    await page.locator("[data-zone='lips']").click();
    await page.locator("[data-face-treatment='aes_filler']").click();
    await page.getByRole("button", { name: "One more" }).click();
    check((await page.locator("[data-face-fee]").getAttribute("data-face-fee")) === "300", "two syringes at 150 show 300 before saving");
    await page.locator("[data-face-save]").click();
    check(await until(async () => (await marksOf(face.id, "aes_filler")).length === 1), "the filler is stored");
    const [filler] = await marksOf(face.id, "aes_filler");
    check(filler.quantity === 2 && filler.fee === 300, "2 syringes, 300", JSON.stringify({ q: filler.quantity, fee: filler.fee }));

    /* ── Ready to bill ──────────────────────────────────────────────── */
    console.log("Ready to bill");
    check(await until(async () => (await page.locator("[data-face-ready]").getAttribute("data-face-ready")) === "2"), "both are on the tab's Ready to bill");
    const billHref = (await page.locator("[data-face-bill]").getAttribute("href")) ?? "";
    check(billHref.includes(toxin.id) && billHref.includes(filler.id), "Bill names both");
    await page.goto(`${BASE}/c/${face.slug}/invoices`, { timeout: 120000 });
    check(await until(async () => (await page.locator(`[data-desk-bill='${face.patientId}']`).count()) > 0, 60000), "the desk's Ready to bill lists the patient");
    const lineValues = (p: Page) => p.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    await page.goto(`${BASE}${billHref}`, { timeout: 120000 });
    check(
      await until(async () => (await lineValues(page)).includes("Botulinum toxin — Forehead, Glabella, Crow's feet (3 areas · 54u)"), 60000),
      "the invoice builder writes the toxin's line",
      JSON.stringify((await lineValues(page)).filter((v) => v.length > 12))
    );
    check((await lineValues(page)).includes("Dermal filler — Lips (2 syringes)"), "and the filler's");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60000 });
    const invoiceId = new URL(page.url()).pathname.split("/").pop()!;
    const linked = await q(
      `select iim.mark_id, ii.amount::float as amount, d.commission_percent::float as rate
         from invoice_items ii join invoice_item_marks iim on iim.invoice_item_id = ii.id
         left join invoice_line_doctors d on d.invoice_item_id = ii.id
        where ii.invoice_id = $1`,
      [invoiceId]
    );
    check(linked.length === 2, "the invoice is linked to both treatments", JSON.stringify(linked));
    check(linked.find((l) => l.mark_id === toxin.id)?.amount === 210, "the toxin billed at 210");
    check(linked.every((l) => l.rate === 40), "with the doctor's 40% on each line — their share, as for any chart work", JSON.stringify(linked.map((l) => l.rate)));

    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-face-map]", { timeout: 60000 });
    check(await until(async () => (await page.locator("[data-face-ready]").count()) === 0), "billed, nothing waits on Ready to bill");
    check((await page.locator("[data-face-billed]").count()) === 1, "and the Billed list shows the invoice");
    const feeAfter = await page.request.patch(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks/${toxin.id}`, {
      data: { op: "fee", eventId: crypto.randomUUID(), fee: 150 },
    });
    check(feeAfter.status() === 409, "a billed treatment's price cannot be changed on the chart", String(feeAfter.status()));

    /* ── Changes ────────────────────────────────────────────────────── */
    console.log("Changes");
    // Repeat: the toxin again, same areas and units.
    await page.locator(`[data-face-repeat='${toxin.id}']`).first().click();
    await page.waitForSelector("[data-face-panel='record']", { timeout: 10000 });
    check((await page.locator("[data-zone][aria-pressed='true']").count()) === 4 && (await page.locator("[data-face-panel='record']").innerText()).includes("54u in total"), "Repeat starts the same toxin on the same areas, the same units");
    await page.locator("[data-face-save]").click();
    check(await until(async () => (await marksOf(face.id, "aes_toxin")).length === 2), "and saves it");
    const repeat = (await marksOf(face.id, "aes_toxin"))[1];
    check(repeat.fee === 210, "at today's list price, 210");
    // By hand, then back to the list.
    const manual = await page.request.patch(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks/${repeat.id}`, {
      data: { op: "fee", eventId: crypto.randomUUID(), fee: 180 },
    });
    check(manual.status() === 200 && (await marksOf(face.id, "aes_toxin"))[1].fee === 180, "this patient's price can be set by hand: 180");
    await page.request.patch(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks/${repeat.id}`, { data: { op: "fee", eventId: crypto.randomUUID(), fee: null } });
    const back = (await marksOf(face.id, "aes_toxin"))[1];
    check(back.fee === 210 && back.fee_manual === false, "and put back to the list's 210");
    // Undo, within two minutes.
    const undo = await page.request.delete(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks/${repeat.id}`);
    check(undo.status() === 409, "a treatment changed since it was recorded cannot be undone — it is voided instead", String(undo.status()));
    const prp = crypto.randomUUID();
    await page.request.post(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks`, {
      data: { id: prp, eventId: crypto.randomUUID(), treatmentKey: "aes_prp", areas: [{ zone: "scalp" }] },
    });
    // Every note joins the Notes feed, saying where it came from.
    const noted = crypto.randomUUID();
    await page.request.post(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks`, {
      data: { id: noted, eventId: crypto.randomUUID(), treatmentKey: "aes_booster", areas: [{ zone: "cheek_r" }, { zone: "cheek_l" }], note: "Profhilo batch PH-4471, tolerated well" },
    });
    await page.goto(`${BASE}/c/${face.slug}/patients/${face.patientId}?tab=notes`, { timeout: 120000 });
    check(
      await until(async () => (await page.locator(`[data-feed-key='face:${noted}']`).innerText().catch(() => "")).includes("Profhilo batch PH-4471"), 30000),
      "a face treatment's note is in the patient's Notes, from the Face chart"
    );
    check((await page.locator(`[data-feed-key='face:${noted}']`).innerText()).includes("Skin booster · Cheeks"), "named by the treatment and where on the face");
    const undone = await page.request.delete(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks/${prp}`);
    check(undone.status() === 200 && (await q(`select 1 from chart_marks where id = $1`, [prp])).length === 0, "a mis-tap is undone within two minutes");
    const voided = await page.request.patch(`${BASE}/api/c/${face.slug}/patients/${face.patientId}/face/marks/${repeat.id}`, {
      data: { op: "void", eventId: crypto.randomUUID(), reason: "Recorded twice" },
    });
    const v = (await marksOf(face.id, "aes_toxin"))[1];
    check(voided.status() === 200 && !!v.voided_at && v.void_reason === "Recorded twice", "voided, it stays, with the reason");
    await page.goto(fileUrl, { timeout: 120000 });
    await page.waitForSelector("[data-face-map]", { timeout: 60000 });
    check((await page.locator(`[data-face-entry='${repeat.id}']`).count()) === 0, "out of the history until Show voided");
    check((await page.locator(`[data-face-ready-item='${repeat.id}']`).count()) === 0, "and never on Ready to bill");
    // Work with no price yet waits to be billed all the same, as on the dental chart.
    check((await page.locator(`[data-face-ready-item='${noted}']`).count()) === 1, "while the booster, recorded with no price yet, waits there for one");
    // On the toxin's row in Recent and in History alike.
    check(
      (await page.locator(`[data-face-entry='${toxin.id}'] [data-due-again]`).first().innerText().catch(() => "")).startsWith("Touch-up due around"),
      "the latest toxin says when the patient is due again"
    );
    await page.context().close();

    /* ── A medical centre with both charts ──────────────────────────── */
    console.log("A medical centre with both");
    const cp = await signIn(browser, centre.email);
    cp.on("pageerror", (e) => errors.push(e.message));
    const both = crypto.randomUUID();
    const rec = await cp.request.post(`${BASE}/api/c/${centre.slug}/patients/${centre.patientId}/face/marks`, {
      data: { id: both, eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "glabella", units: 20 }] },
    });
    check(rec.status() === 200, "it records on the face");
    const dentChart = (await (await cp.request.get(`${BASE}/api/c/${centre.slug}/patients/${centre.patientId}/dental`)).json()) as { chart: { marks: { id: string }[] } };
    check(!dentChart.chart.marks.some((m) => m.id === both), "and its dental chart never reads the face work");
    await cp.goto(`${BASE}/c/${centre.slug}/patients/${centre.patientId}`, { timeout: 180000 });
    await cp.waitForSelector("main", { timeout: 60000 });
    const tabs = await cp.locator("main").innerText();
    check(tabs.includes("Dental chart") && tabs.includes("Face chart"), "the file has both tabs");
    await cp.context().close();

    check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
