/**
 * A treatment priced once, whole, and paid off over the visits (0080).
 *
 * The billing and payment half of qa-treatment, on its own fixtures, so it
 * runs in minutes:
 *
 * - started work is ready to bill at its whole price, one line, however many
 *   visits it took; billed, it is not offered again;
 * - Take payment on the patient file pays the oldest open invoice first, an
 *   invoice not sent yet counts, and more than is owed cannot be taken;
 * - each treatment on the chart says how much of it is paid;
 * - today's board says what the patient owes, with Take payment.
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
async function until(fn: () => Promise<boolean>, ms = 20000): Promise<boolean> {
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
  const slug = `qapay${tag}`;
  const [clinic] = await q(
    `insert into clinics (name, slug, specialty, specialties, features, dental_billing_since)
     values ('QA Pay', $1, 'dental', '{dental}', '{"dental": true}', now() - interval '7 days') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const user = async (email: string, name: string) =>
    (await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, hash, name]))[0].id as string;
  const docUser = await user(`pay-doc-${tag}@test.local`, "Dr Pay");
  const deskUser = await user(`pay-desk-${tag}@test.local`, "Desk Pay");
  const [doc] = await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1, $2, 'doctor', true, 'Dr.', '{"level":"full"}') returning id`, [
    clinic.id,
    docUser,
  ]);
  await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', false, '{"level":"custom","caps":{"dashboard":true,"patients":true,"calendar":true,"invoices":true}}')`,
    [clinic.id, deskUser]
  );
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Sara Pay', '+962790008888', 'staff') returning id`, [clinic.id]);
  const price = async (key: string, variant: string | null, amount: number, name: string) =>
    (
      await q(
        `insert into services (clinic_id, name, duration_min, price, chart_key, chart_variant, price_unit, chart_owned, bookable_online)
         values ($1, $2, 30, $3, $4, $5, 'item', true, false) returning id`,
        [clinic.id, name, amount, key, variant]
      )
    )[0].id as string;
  const crownSvc = await price("crown", null, 110, "Crown");
  const rctSvc = await price("rct", null, 90, "Root canal treatment");
  const scSvc = await price("scaling", null, 30, "Scaling & polishing");
  const mark = async (key: string, site: string, label: string, fee: number, svc: string) =>
    (
      await q(
        `insert into chart_marks (clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status, fee, service_id, performed_by, recorded_by)
         values ($1, $2, $3, $4, $5, $5, 'dot', 'procedure', 'planned', $6, $7, $8, $9) returning id`,
        [clinic.id, patient.id, site, key, label, fee, svc, doc.id, docUser]
      )
    )[0].id as string;
  const crown = await mark("crown", "16", "Crown", 110, crownSvc);
  const rct = await mark("rct", "26", "Root canal treatment", 90, rctSvc);
  const sc = await mark("scaling", "mouth", "Scaling & polishing", 30, scSvc);
  const step = (markId: string, s: string, daysAgo: number) =>
    q(
      `insert into chart_mark_steps (clinic_id, mark_id, patient_id, step, performed_by, recorded_by, done_at) values ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval)`,
      [clinic.id, markId, patient.id, s, doc.id, docUser, String(daysAgo)]
    );
  // Each started — the cleaning over two visits, two days apart.
  await step(crown, "prep", 0);
  await step(rct, "access", 0);
  await step(sc, "upper", 2);
  await step(sc, "lower", 0);
  // Today's visit, finished, for the board.
  await q(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status, source, arrived_at, seated_at, finished_at)
     values ($1, $2, $3, now() - interval '1 hour', now() - interval '30 minutes', 'completed', 'staff', now() - interval '70 minutes', now() - interval '60 minutes', now() - interval '30 minutes')`,
    [clinic.id, patient.id, doc.id]
  );

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const desk = await signIn(browser, `pay-desk-${tag}@test.local`);
    desk.on("pageerror", (e) => errors.push(e.message));

    /* ── Billed once, whole ─────────────────────────────────────────── */
    console.log("Billed once, whole");
    const billable = async () =>
      ((await (await desk.request.get(`${BASE}/api/c/${slug}/patients/${patient.id}/dental/billable`)).json()) as { lines: { markId: string; qty: number; unitPrice: number }[] }).lines;
    const lines = await billable();
    const of = (id: string) => lines.find((l) => l.markId === id);
    check(lines.length === 3, "all three started treatments are ready to bill", JSON.stringify(lines));
    check(of(sc)?.qty === 1 && of(sc)?.unitPrice === 30, "the cleaning, done over two visits, is one line at its whole price: 30", JSON.stringify(of(sc)));
    check(of(crown)?.unitPrice === 110 && of(rct)?.unitPrice === 90, "the crown at 110 and the root canal at 90");

    await desk.goto(`${BASE}/c/${slug}/invoices/new?patient=${patient.id}&marks=${crown},${rct}`, { timeout: 120000 });
    await desk.waitForSelector("input:not([type=hidden])", { timeout: 60000 });
    const values = () => desk.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    check(await until(async () => (await values()).some((v) => v.includes("Crown")), 60000), "Bill opens a new invoice with the crown's line");
    await desk.getByRole("button", { name: "Create", exact: true }).click();
    await desk.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60000 });
    const inv1 = new URL(desk.url()).pathname.split("/").pop()!;
    const billed = await q(`select ii.qty::float as qty, ii.unit_price::float as price from invoice_items ii where ii.invoice_id = $1 order by sort`, [inv1]);
    check(billed.length === 2 && billed.every((l) => l.qty === 1), "the invoice bills each once", JSON.stringify(billed));
    const after = await billable();
    check(after.length === 1 && after[0].markId === sc, "billed, they are not offered again; the cleaning still is", JSON.stringify(after));

    /* ── Take payment ────────────────────────────────────────────────── */
    console.log("Take payment");
    const owedOn = () => desk.locator(`[data-take-payment='${patient.id}']`).getAttribute("data-owed");
    const paidOn = async (id: string) => (await q(`select coalesce(sum(amount), 0)::float as n from payments where invoice_id = $1`, [id]))[0].n;
    const take = async (amount: string) => {
      await desk.locator(`[data-take-payment='${patient.id}'] button`).click();
      const form = desk.locator("[data-take-payment-form]");
      await form.waitFor({ timeout: 10000 });
      await form.locator("[data-take-payment-amount]").fill(amount);
      await form.locator("[data-take-payment-save]").click();
      await form.waitFor({ state: "detached", timeout: 20000 });
    };
    await desk.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=overview`, { timeout: 120000 });
    await desk.waitForSelector(`[data-take-payment='${patient.id}']`, { timeout: 60000 });
    check((await owedOn()) === "200", "the file says 200 is owed: an invoice not sent yet still counts", String(await owedOn()));
    await desk.locator(`[data-take-payment='${patient.id}'] button`).click();
    const form = desk.locator("[data-take-payment-form]");
    await form.waitFor({ timeout: 10000 });
    check((await form.locator("[data-take-payment-amount]").inputValue()) === "200", "Take payment starts at all of it");
    await form.locator("[data-take-payment-amount]").fill("250");
    check(await form.locator("[data-take-payment-save]").isDisabled(), "and will not take more than is owed");
    await desk.keyboard.press("Escape");
    await form.waitFor({ state: "detached", timeout: 10000 });
    await take("50");
    check(await until(async () => (await paidOn(inv1)) === 50), "50 at this visit is recorded on the invoice");
    check(await until(async () => (await owedOn()) === "150"), "and the balance drops to 150 at once");

    await desk.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=dental`, { timeout: 120000 });
    await desk.waitForSelector("[data-dental-chart]", { timeout: 120000 });
    await desk.locator(`[data-mark='${crown}'] [data-open-item]`).first().click();
    await desk.locator(`[data-procedure='${crown}']`).waitFor({ timeout: 15000 });
    const paidLine = await desk.locator(`[data-paid-line='${crown}']`).innerText();
    check(paidLine.includes("27.5") && paidLine.includes("82.5"), "the crown says 27.50 of its 110 is paid, 82.50 left — its share of what came in", paidLine);

    // The cleaning billed too; then 160 settles the older invoice's 150 and puts 10 on the newer.
    await desk.goto(`${BASE}/c/${slug}/invoices/new?patient=${patient.id}&marks=${sc}`, { timeout: 120000 });
    check(await until(async () => (await values()).some((v) => v.includes("Scaling")), 60000), "the cleaning is billed, whole");
    await desk.getByRole("button", { name: "Create", exact: true }).click();
    await desk.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 60000 });
    const inv2 = new URL(desk.url()).pathname.split("/").pop()!;
    await desk.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=overview`, { timeout: 120000 });
    await desk.waitForSelector(`[data-take-payment='${patient.id}']`, { timeout: 60000 });
    check((await owedOn()) === "180", "now 180 is owed across the two", String(await owedOn()));
    await take("160");
    check(await until(async () => (await paidOn(inv1)) === 200 && (await paidOn(inv2)) === 10), "160 settles the older invoice first, and the other 10 goes on the newer");
    const st = await q(`select id, status from invoices where id = any($1::uuid[])`, [[inv1, inv2]]);
    check(st.find((x) => x.id === inv1)?.status === "paid" && st.find((x) => x.id === inv2)?.status === "partially_paid", "the first paid, the second part-paid", JSON.stringify(st));

    /* ── Today's board ───────────────────────────────────────────────── */
    console.log("Today's board");
    await desk.goto(`${BASE}/c/${slug}/calendar`, { timeout: 120000 });
    await desk.waitForSelector("[data-flow-board]", { timeout: 60000 });
    const card = desk.locator("[data-flow-card]").first();
    await card.waitFor({ timeout: 30000 });
    check(await until(async () => (await card.innerText()).includes("Owes")), "the patient's card on today's board says what they owe", await card.innerText());
    check((await card.locator(`[data-take-payment='${patient.id}']`).getAttribute("data-owed")) === "20", "with Take payment for the 20 left");
    check(errors.length === 0, "no page errors", errors.join(" | "));
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
