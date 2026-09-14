/**
 * A receipt is not an invoice.
 *
 * An invoice demands and a receipt acknowledges. Until now this product had
 * only the first: a settled invoice was re-sent with a PAID stamp, which is the
 * same document wearing a badge, and not the thing a patient hands an employer.
 *
 * What is checked here is mostly what a receipt must *refuse* to be. It does not
 * exist before the invoice is settled; it has its own number series, so a
 * courtesy document never consumes a number the tax authority expects to be an
 * invoice; and it is never filed with anybody.
 *
 *   npx tsx scripts/qa-receipts.ts
 */
import { chromium } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { nextInvoiceNumber, nextReceiptNumber, refreshInvoiceStatus } from "../src/lib/invoices";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const c = db as unknown as PoolClient;

  const tag = `qarcp${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, currency, default_locale, invoice_prefix, timezone)
       values ('QA Receipts', 'إيصالات', $1, 'JOD', 'en', 'QRC', 'Asia/Amman') returning id`,
      [tag]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale)
       values ($1, $2, 'QA Receipt Owner', 'en') returning id`,
      [`owner-${tag}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1, 'QA Patient', $2) returning id`,
      [clinic.id, `+96279${Date.now().toString().slice(-7)}`]
    )
  ).rows[0];

  const mkInvoice = async (total: number) => {
    const { seq, number } = await nextInvoiceNumber(c, clinic.id);
    const inv = (
      await db.query(
        `insert into invoices (clinic_id, patient_id, seq, number, status, currency,
                               subtotal, total, issue_date)
         values ($1, $2, $3, $4, 'sent', 'JOD', $5, $5, current_date) returning id, public_token`,
        [clinic.id, patient.id, seq, number, total]
      )
    ).rows[0];
    await db.query(
      `insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount, tax_category, sort)
       values ($1, $2, 'Cleaning', 1, $3, $3, 'O', 0)`,
      [clinic.id, inv.id, total]
    );
    return { id: inv.id as string, number: number as string };
  };

  const pay = async (invoiceId: string, amount: number, method = "cash", reference = "") => {
    await db.query(
      `insert into payments (clinic_id, invoice_id, patient_id, amount, method, reference, paid_at)
       values ($1, $2, $3, $4, $5, $6, now())`,
      [clinic.id, invoiceId, patient.id, amount, method, reference]
    );
    await refreshInvoiceStatus(c, invoiceId);
  };

  // ---- the number series is its own ---------------------------------------
  /*
    The point of a separate counter: a receipt must never consume a number out of
    the invoice sequence. In a clinic filing with JoFotara a gap in that series
    is a question somebody has to answer.
  */
  const invBefore = (await db.query(`select invoice_counter from clinics where id = $1`, [clinic.id]))
    .rows[0].invoice_counter;
  const r1 = await nextReceiptNumber(c, clinic.id);
  const r2 = await nextReceiptNumber(c, clinic.id);
  const invAfter = (await db.query(`select invoice_counter from clinics where id = $1`, [clinic.id]))
    .rows[0].invoice_counter;

  check("a receipt number uses the receipt prefix", r1.number.startsWith("RCP-"), r1.number);
  check("and its own counter, which advances", r2.seq === r1.seq + 1, `${r1.seq} → ${r2.seq}`);
  check("and never touches the invoice counter", invAfter === invBefore, `${invBefore} → ${invAfter}`);

  // ---- not before it is settled -------------------------------------------
  const partly = await mkInvoice(200);
  await pay(partly.id, 50);
  const partlyStatus = (await db.query(`select status from invoices where id = $1`, [partly.id]))
    .rows[0].status;
  check("a part-paid invoice is partially_paid", partlyStatus === "partially_paid", partlyStatus);

  const settled = await mkInvoice(120);
  await pay(settled.id, 70, "cash");
  await pay(settled.id, 50, "cliq", "TRX-99");
  const settledStatus = (await db.query(`select status from invoices where id = $1`, [settled.id]))
    .rows[0].status;
  check("a fully paid invoice is paid", settledStatus === "paid", settledStatus);

  // ---- the screen offers it only once settled -----------------------------
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-${tag}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });

  await page.goto(`${BASE}/c/${tag}/invoices/${partly.id}`);
  await page.waitForLoadState("networkidle");
  check(
    "a part-paid invoice offers no receipt",
    (await page.getByRole("button", { name: "Send receipt" }).count()) === 0
  );
  check(
    "but does still offer to take a payment",
    (await page.getByRole("button", { name: "Record payment" }).count()) === 1
  );

  await page.goto(`${BASE}/c/${tag}/invoices/${settled.id}`);
  await page.waitForLoadState("networkidle");
  check(
    "a settled invoice offers the receipt",
    (await page.getByRole("button", { name: "Send receipt" }).count()) === 1
  );
  check(
    "and the invoice send becomes a re-send",
    (await page.getByRole("button", { name: "Re-send invoice" }).count()) === 1
  );

  // ---- the document itself -------------------------------------------------
  /*
    Issued directly rather than through the send button, which would need a live
    WhatsApp session and the worker's Chromium. What is under test here is the
    page a patient opens, not the delivery.
  */
  const issued = await nextReceiptNumber(c, clinic.id);
  const tok = (
    await db.query(
      `update invoices set receipt_seq = $2, receipt_number = $3,
              receipt_token = encode(gen_random_bytes(16), 'hex'),
              receipt_issued_at = now()
        where id = $1 returning receipt_token`,
      [settled.id, issued.seq, issued.number]
    )
  ).rows[0].receipt_token as string;

  await page.goto(`${BASE}/rcp/${tok}`);
  await page.waitForLoadState("networkidle");
  const rcp = (await page.locator("body").innerText()).replace(/\s+/g, " ");

  check("the receipt page renders", !rcp.includes("404") && rcp.includes("Receipt"), rcp.slice(0, 90));
  check("it carries its own number", rcp.includes(issued.number), issued.number);
  check("it names the invoice it settles", rcp.includes(settled.number), settled.number);
  check("it lists every payment", rcp.includes("Cash") && rcp.includes("CliQ"));
  check("it shows the reference where there is one", rcp.includes("TRX-99"));
  check("it totals what was received", /120\.00/.test(rcp));
  check("it says it is paid in full", rcp.includes("PAID IN FULL"));
  /*
    The line that keeps a clinic out of trouble: two documents both claiming to
    be the tax record of one visit is exactly the confusion this must not cause.
  */
  check("and that it is not the tax document", rcp.includes("not a tax invoice"));

  // ---- never filed ---------------------------------------------------------
  const filed = await db.query(
    `select count(*)::int as n from jobs where kind like '%einvoice%' and payload::text like $1`,
    [`%${settled.id}%`]
  );
  check("issuing a receipt files nothing with the tax authority", filed.rows[0].n === 0, `${filed.rows[0].n} jobs`);

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();

  // ---- teardown ------------------------------------------------------------
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where email like $1`, [`%-${tag}@test.local`]);
  await db.end();

  console.log(`\nreceipts: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
