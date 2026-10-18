/**
 * Dental labs, and what a treatment cost in the doctor's share (0081, 0082).
 *
 * Yamen, 2026-10-17: costs in the treatments, calculated between the doctors;
 * a place for the dental lab, in-house or any number outside.
 *
 * - Settings → Dental labs: an outside lab and the clinic's own, each with its
 *   prices; a lab's zirconia crown at 45.
 * - The chart: a prepared zirconia crown asks to go to a lab; Send to lab
 *   starts at that lab's price; the case shows at the lab, then back.
 * - Lab work: Out, Received, and To pay — Mark paid records one expense in the
 *   Lab category, and the case's cost is then settled.
 * - The share: (price − lab − materials) × rate on the shared deal, price ×
 *   rate − costs on the doctor's; a corrected lab cost moves it, a cancelled
 *   case leaves it, the clinic's own lab is never owed.
 *
 * Run against a warm server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { earningsForDoctor } from "../src/lib/earnings";

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
/** Poll until `fn` is true or the time is up. */
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
  const c = db as unknown as PoolClient;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qalabs${tag}`;
  const [clinic] = await q(
    `insert into clinics (name, slug, specialty, specialties, features, dental_billing_since)
     values ('QA Labs', $1, 'dental', '{dental}', '{"dental": true}', now() - interval '7 days') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  // The expense categories every clinic starts with (provisionClinic seeds them): a lab's bill is filed under Lab.
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  const [docUser] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Dr Lab Owner', 'en') returning id`, [`labs-doc-${tag}@test.local`, hash]);
  const [doc] = await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions, commission_percent)
     values ($1, $2, 'doctor', true, 'Dr.', '{"level":"full"}', 40) returning id`,
    [clinic.id, docUser.id]
  );
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Lab Patient', '+962790007777', 'staff') returning id`, [clinic.id]);
  // A zirconia crown at 300 on the list, with 20 of materials; one on 16, prepared today.
  const [svc] = await q(
    `insert into services (clinic_id, name, duration_min, price, material_cost, chart_key, chart_variant, price_unit, chart_owned, bookable_online)
     values ($1, 'Crown (Zirconia)', 30, 300, 20, 'crown', 'zirconia', 'item', true, false) returning id`,
    [clinic.id]
  );
  const [crown] = await q(
    `insert into chart_marks (clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status, detail, fee, service_id, performed_by, recorded_by)
     values ($1, $2, '16', 'crown', 'Crown', 'تاج', 'crown', 'procedure', 'planned', '{"material":"zirconia"}', 300, $3, $4, $5) returning id`,
    [clinic.id, patient.id, svc.id, doc.id, docUser.id]
  );
  await q(
    `insert into chart_mark_steps (clinic_id, mark_id, patient_id, step, data, performed_by, recorded_by) values ($1, $2, $3, 'prep', '{"shade":"A2","material":"zirconia"}', $4, $5)`,
    [clinic.id, crown.id, patient.id, doc.id, docUser.id]
  );

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const page = await signIn(browser, `labs-doc-${tag}@test.local`);
    page.on("pageerror", (e) => errors.push(e.message));

    /* ── Settings → Dental labs ─────────────────────────────────────── */
    console.log("Settings → Dental labs");
    await page.goto(`${BASE}/c/${slug}/settings/labs`, { timeout: 120000 });
    await page.waitForSelector("[data-dental-labs]", { timeout: 60000 });
    check((await page.locator("nav a", { hasText: "Dental labs" }).count()) > 0, "Dental labs has its place in Settings, beside Treatment prices");
    await page.locator("[data-lab-name]").fill("Smile Lab");
    await page.locator("[data-lab-save]").click();
    const labOf = async (name: string) => (await q(`select * from dental_labs where clinic_id = $1 and name = $2`, [clinic.id, name]))[0];
    check(await until(async () => !!(await labOf("Smile Lab"))), "an outside lab is added");
    const smile = await labOf("Smile Lab");
    await page.locator(`[data-lab-prices='${smile.id}']`).waitFor({ timeout: 10000 });
    const box = page.locator(`[data-price-box='${smile.id}:crown:zirconia']`);
    await box.fill("45");
    await box.press("Enter");
    check(
      await until(async () => (await q(`select cost::float as cost from dental_lab_prices where lab_id = $1 and chart_key = 'crown' and chart_variant = 'zirconia'`, [smile.id]))[0]?.cost === 45),
      "its zirconia crown is priced at 45"
    );
    await page.locator("[data-lab-new]").click();
    await page.locator("[data-lab-name]").fill("Our lab");
    await page.getByText("It is our own lab, inside the clinic").click();
    await page.locator("[data-lab-save]").click();
    check(await until(async () => (await labOf("Our lab"))?.in_house === true), "and the clinic's own lab, in-house");
    const own = await labOf("Our lab");

    /* ── The chart: send to lab ──────────────────────────────────────── */
    console.log("Send to lab");
    await page.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=dental`, { timeout: 120000 });
    await page.waitForSelector("[data-dental-chart]", { timeout: 120000 });
    check((await page.locator("nav a", { hasText: "Lab work" }).count()) > 0, "the clinic keeps a lab, so Lab work is in the nav");
    await page.locator(`[data-mark='${crown.id}'] [data-open-item]`).first().click();
    await page.locator(`[data-procedure='${crown.id}']`).waitFor({ timeout: 15000 });
    const materials = await page.locator(`[data-materials-line='${crown.id}']`).getAttribute("data-materials");
    check(materials === "20", "the crown's materials cost the list's 20", String(materials));
    await page.locator(`[data-lab-send='${crown.id}']`).click();
    const form = page.locator(`[data-lab-form='${crown.id}']`);
    await form.waitFor({ timeout: 10000 });
    await form.locator("[data-lab-pick]").selectOption(smile.id);
    check((await form.locator("[data-lab-cost-field]").inputValue()) === "45", "Send to lab starts at Smile Lab's price for a zirconia crown: 45");
    await form.locator("[data-lab-due='5']").click();
    await form.locator("[data-lab-send-save]").click();
    const caseOf = async () => (await q(`select *, cost::float as cost from lab_cases where mark_id = $1 order by created_at`, [crown.id]));
    check(
      await until(async () => {
        const [lc] = await caseOf();
        return lc?.status === "sent" && lc.cost === 45 && lc.lab_id === smile.id && lc.shade === "A2" && !!lc.due_on;
      }),
      "the case is recorded: at Smile Lab, 45, due in five days, the shade from the preparation"
    );
    check(await until(async () => (await page.locator(`[data-lab-case]`).getAttribute("data-lab-status")) === "sent"), "and the card shows it at the lab");

    /* ── The share ───────────────────────────────────────────────────── */
    console.log("The doctor's share");
    // Billed and paid in full: the crown at 300, Dr on 40%, shared deal, 20 of materials frozen.
    const [inv] = await q(
      `insert into invoices (clinic_id, patient_id, seq, number, status, subtotal, total, amount_paid, issue_date)
       values ($1, $2, 1, 'QAL-1', 'sent', 300, 300, 0, current_date) returning id`,
      [clinic.id, patient.id]
    );
    const [item] = await q(
      `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount) values ($1, $2, $3, 'Crown (Zirconia) — tooth 16', 1, 300, 300) returning id`,
      [clinic.id, inv.id, svc.id]
    );
    await q(`insert into invoice_item_marks (invoice_item_id, mark_id, clinic_id) values ($1, $2, $3)`, [item.id, crown.id, clinic.id]);
    await q(`insert into invoice_line_doctors (invoice_item_id, clinic_id, doctor_member_id, commission_percent, costs_rule, material_cost) values ($1, $2, $3, 40, 'shared', 20)`, [
      item.id,
      clinic.id,
      doc.id,
    ]);
    await q(`insert into payments (clinic_id, invoice_id, patient_id, amount, method) values ($1, $2, $3, 300, 'cash')`, [clinic.id, inv.id, patient.id]);
    await q(`update invoices set amount_paid = 300, status = 'paid' where id = $1`, [inv.id]);
    const scope = { clinicId: clinic.id as string, from: new Date("2020-01-01"), to: new Date("2099-01-01") };
    const share = async () => (await earningsForDoctor(c, scope, doc.id)).earned;
    check((await share()) === 94, "shared: (300 − 45 lab − 20 materials) × 40% = 94", String(await share()));
    // The lab's bill says 50: corrected on the case, the share follows.
    const [lc] = await caseOf();
    const patch = (caseId: string, body: unknown) => page.request.patch(`${BASE}/api/c/${slug}/patients/${patient.id}/dental/labs/${caseId}`, { data: body });
    check((await patch(lc.id, { op: "cost", cost: 50 })).ok(), "the lab's cost is corrected to 50");
    check((await share()) === 92, "and the share follows: (300 − 50 − 20) × 40% = 92", String(await share()));
    await q(`update invoice_line_doctors set costs_rule = 'doctor' where invoice_item_id = $1`, [item.id]);
    check((await share()) === 50, "on the doctor's deal: 300 × 40% − 70 = 50", String(await share()));
    await q(`update invoice_line_doctors set costs_rule = 'shared' where invoice_item_id = $1`, [item.id]);
    // A remake sent and called off costs nothing.
    const remake = await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/dental/marks/${crown.id}/lab`, {
      data: { id: crypto.randomUUID(), labId: smile.id, cost: 30, dueOn: null, shade: "", note: "remake" },
    });
    const remakeId = (await remake.json()).labCase?.id as string;
    check(remake.ok() && (await share()) === 80, "a remake at 30 comes off too: (300 − 80 − 20) × 40% = 80", String(await share()));
    check((await patch(remakeId, { op: "cancel" })).ok() && (await share()) === 92, "called off, it costs nothing again: 92", String(await share()));

    /* ── Lab work ────────────────────────────────────────────────────── */
    console.log("Lab work");
    // Work at the clinic's own lab too: never owed.
    await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/dental/marks/${crown.id}/lab`, {
      data: { id: crypto.randomUUID(), labId: own.id, cost: 25, dueOn: null, shade: "", note: "" },
    });
    await page.goto(`${BASE}/c/${slug}/labs`, { timeout: 120000 });
    await page.waitForSelector("[data-lab-out]", { timeout: 60000 });
    check((await page.locator(`[data-lab-out] [data-lab-work='${lc.id}']`).innerText()).includes("Lab Patient"), "Out lists the crown at Smile Lab, by patient");
    await page.locator(`[data-lab-received='${lc.id}']`).click();
    check(await until(async () => (await caseOf())[0]?.status === "received"), "Received records it back");
    await page.getByRole("tab", { name: /To pay/ }).click();
    await page.waitForSelector("[data-lab-pay]", { timeout: 10000 });
    check(
      (await page.locator(`[data-lab-pay-group='${smile.id}']`).count()) === 1 && (await page.locator(`[data-lab-pay-group='${own.id}']`).count()) === 0,
      "To pay lists Smile Lab, and never the clinic's own lab"
    );
    await page.locator(`[data-lab-tick='${lc.id}']`).check();
    await page.locator(`[data-lab-pay-button='${smile.id}']`).click();
    const paid = async () => (await q(`select e.amount::float as amount, e.vendor, k.key from lab_cases lc join expenses e on e.id = lc.expense_id left join expense_categories k on k.id = e.category_id where lc.id = $1`, [lc.id]))[0];
    check(await until(async () => (await paid())?.amount === 50), "Mark paid records 50 in Expenses");
    const p = await paid();
    check(p?.vendor === "Smile Lab" && p.key === "lab", "to Smile Lab, under Lab", JSON.stringify(p));
    const locked = await patch(lc.id, { op: "cost", cost: 10 });
    check(locked.status() === 409 && (await locked.json()).error === "paid", "paid for, its cost is settled: a change is refused");
    check((await share()) === 82, "and the in-house work, 25, still comes off the share: (300 − 50 − 25 − 20) × 40% = 82", String(await share()));
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
