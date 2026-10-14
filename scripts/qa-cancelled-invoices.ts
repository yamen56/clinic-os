/**
 * Cancelled invoices: their payments stop counting, and they can be deleted.
 *
 * Asked for on 2026-10-14. A cancelled invoice's payments were still summed
 * into the takings, the dashboard and the payments list, as if the clinic had
 * earned them; and cancelled invoices sat in the list with no way to clear them.
 *
 *   - Cancelling a paid invoice through the screen takes its payment out of
 *     "Today", out of the payments list, and out of the dashboard's revenue.
 *   - "All" leaves cancelled invoices out; the Cancelled chip lists them.
 *   - A cancelled invoice can be deleted from its page, which lands back on the
 *     Cancelled list without passing through "not found".
 *   - "Delete cancelled invoices" clears the rest, and an invoice filed with
 *     JoFotara stays, because the tax authority holds it.
 *
 * Needs the stack running (npm run dev:all), warm.
 */
try {
  process.loadEnvFile?.();
} catch {
  /* rely on the real environment */
}

import { chromium, type Page } from "playwright";
import { Client } from "pg";

const BASE = process.env.APP_URL || "http://localhost:3000";
const SLUG = "rima-dental";
const C = `/c/${SLUG}`;
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failures.push(`${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
    console.log(`✗ ${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
  }
}

/** The page has hydrated: the Back trail records each page once React runs. */
async function go(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(
    `(JSON.parse(sessionStorage.getItem("clinicti.trail") || "[]").slice(-1)[0] || "") === location.pathname + location.search`,
    undefined,
    { timeout: 180000 }
  );
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
}

/** The figure in a takings tile, by its label. */
async function tile(page: Page, label: string): Promise<number> {
  const text = await page.locator("main").innerText();
  const at = text.indexOf(label);
  const after = text.slice(at + label.length, at + label.length + 40);
  return Number((after.match(/[\d,]+\.\d{2}/)?.[0] ?? "NaN").replace(/,/g, ""));
}

async function main() {
  const db = new Client(PG);
  await db.connect();
  const clinic = (await db.query(`select id, timezone from clinics where slug = $1`, [SLUG])).rows[0];
  const patient = (
    await db.query(`select id from patients where clinic_id = $1 and merged_into is null order by created_at limit 1`, [clinic.id])
  ).rows[0];
  const tag = Date.now().toString(36);
  const made: string[] = [];
  let parked: string[] = [];

  /** An invoice straight into the table, with one payment of `paid` taken now. */
  const invoice = async (name: string, total: number, paid: number, extra: Record<string, unknown> = {}) => {
    const seq = (await db.query(`select coalesce(max(seq), 0) + 1 as s from invoices where clinic_id = $1`, [clinic.id])).rows[0].s;
    const cols = ["clinic_id", "patient_id", "seq", "number", "title", "status", "subtotal", "total", "amount_paid", "sent_at", ...Object.keys(extra)];
    const vals = [clinic.id, patient.id, seq, `QA-CXL-${tag}-${name}`, `QA cancelled ${name}`, paid >= total ? "paid" : "sent", total, total, paid, new Date(), ...Object.values(extra)];
    const id = (
      await db.query(
        `insert into invoices (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
        vals
      )
    ).rows[0].id as string;
    await db.query(
      `insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount) values ($1, $2, $3, 1, $4, $4)`,
      [clinic.id, id, `QA line ${name}`, total]
    );
    if (paid > 0) {
      await db.query(
        `insert into payments (clinic_id, invoice_id, patient_id, amount, method) values ($1, $2, $3, $4, 'cash')`,
        [clinic.id, id, patient.id, paid]
      );
    }
    made.push(id);
    return id;
  };

  const browser = await chromium.launch();
  try {
    const A = await invoice("A", 57.25, 57.25);
    const B = await invoice("B", 31.5, 31.5);
    // Already cancelled and filed with JoFotara: may never be deleted.
    const F = await invoice("F", 12, 12, { einvoice_status: "submitted" });
    await db.query(`update invoices set status = 'void', voided_at = now() where id = $1`, [F]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', "rima@clinic.jo");
    await page.fill('input[name="password"]', "clinic1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000, waitUntil: "commit" });
    await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);

    // ---- before ------------------------------------------------------------
    await go(page, `${C}/invoices`);
    const todayBefore = await tile(page, "Today");
    await go(page, `${C}`);
    const dashText = async () => (await page.locator("main").innerText());
    const dashBefore = await dashText();
    await go(page, `${C}/invoices?tab=payments`);
    check("A's payment is in the payments list before cancelling", (await page.locator("main").innerText()).includes(`QA-CXL-${tag}-A`));

    // ---- cancel A through the screen ---------------------------------------
    await go(page, `${C}/invoices/${A}`);
    await page.getByRole("button", { name: "Void invoice" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Void invoice" }).click();
    await page.waitForFunction(`!!document.querySelector("[data-void-payments-note]")`, undefined, { timeout: 60000 });
    const statusA = (await db.query(`select status from invoices where id = $1`, [A])).rows[0].status;
    check("cancelling from the screen voids the invoice", statusA === "void", statusA);
    check("its page says the payments no longer count", (await page.locator("[data-void-payments-note]").innerText()).includes("not counted"));
    check("and offers to delete it", await page.locator("[data-delete-invoice]").isVisible());

    // ---- the money --------------------------------------------------------
    await go(page, `${C}/invoices`);
    const todayAfter = await tile(page, "Today");
    check("Today drops by exactly the cancelled payment", Math.abs(todayBefore - todayAfter - 57.25) < 0.001, `${todayBefore} → ${todayAfter}`);
    const expectToday = Number(
      (
        await db.query(
          `select coalesce(sum(p.amount), 0) as s from payments p join invoices i on i.id = p.invoice_id
            where p.clinic_id = $1 and i.status <> 'void'
              and (p.paid_at at time zone $2)::date = (now() at time zone $2)::date`,
          [clinic.id, clinic.timezone]
        )
      ).rows[0].s
    );
    check("and equals the payments on invoices still standing", Math.abs(todayAfter - expectToday) < 0.001, `${todayAfter} vs ${expectToday}`);
    await go(page, `${C}/invoices?tab=payments`);
    const payText = await page.locator("main").innerText();
    check("the cancelled invoice's payment leaves the payments list", !payText.includes(`QA-CXL-${tag}-A`));
    check("a standing invoice's payment stays in it", payText.includes(`QA-CXL-${tag}-B`));
    const csv = await (await page.request.get(`${BASE}/api/c/${SLUG}/payments/export`)).text();
    check("and the payments export leaves it out", !csv.includes(`QA-CXL-${tag}-A`) && csv.includes(`QA-CXL-${tag}-B`));
    await go(page, `${C}`);
    const dashAfter = await dashText();
    check("the dashboard's figures move", dashAfter !== dashBefore);

    // ---- the list -----------------------------------------------------------
    await go(page, `${C}/invoices`);
    const allText = await page.locator("main").innerText();
    check("All leaves cancelled invoices out", !allText.includes(`QA cancelled A`) && !allText.includes(`QA cancelled F`) && allText.includes(`QA cancelled B`));
    await go(page, `${C}/invoices?status=cancelled`);
    const cxlText = await page.locator("main").innerText();
    check("Cancelled lists them", cxlText.includes(`QA cancelled A`) && cxlText.includes(`QA cancelled F`));
    check("and says why a filed one stays", await page.locator("[data-filed-stay]").isVisible());
    const deletable = Number(
      (await db.query(`select count(*) from invoices i where i.clinic_id = $1 and i.status = 'void' and i.credit_note_of is null
         and i.einvoice_status not in ('submitted','pending') and not exists (select 1 from invoices n where n.credit_note_of = i.id)`, [clinic.id])).rows[0].count
    );
    check("Delete cancelled counts only the deletable ones",
      Number(await page.locator("[data-delete-cancelled]").getAttribute("data-delete-cancelled")) === deletable, `${deletable}`);

    // ---- delete A from its page --------------------------------------------
    await go(page, `${C}/invoices/${A}`);
    await page.evaluate(`window.__nf = false; new MutationObserver(() => { if (document.body.innerText.includes("can't find this page")) window.__nf = true; }).observe(document.body, { childList: true, subtree: true, characterData: true })`);
    await page.locator("[data-delete-invoice]").click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete invoice" }).click();
    await page.waitForURL((u) => u.search.includes("status=cancelled"), { timeout: 60000, waitUntil: "commit" });
    check("deleting lands back on the Cancelled list", true);
    const nf = await page.evaluate(`window.__nf === true`).catch(() => false);
    check("without passing through \"not found\"", !nf);
    const left = (await db.query(`select (select count(*) from invoices where id = $1)::int as inv, (select count(*) from payments where invoice_id = $1)::int as pay`, [A])).rows[0];
    check("the invoice and its payment are gone", left.inv === 0 && left.pay === 0, JSON.stringify(left));
    const logged = (await db.query(`select detail from audit_log where action = 'invoice.delete' and entity_id = $1`, [A])).rows[0];
    check("the audit log keeps what it was", logged?.detail?.number === `QA-CXL-${tag}-A` && Number(logged?.detail?.paid) === 57.25, JSON.stringify(logged?.detail));

    // ---- delete the rest at once -------------------------------------------
    const D = await invoice("D", 20, 0);
    await db.query(`update invoices set status = 'void', voided_at = now() where id = $1`, [D]);
    // The bulk delete clears the whole clinic's cancelled invoices: set aside any this run did not make.
    parked = (
      await db.query(`update invoices set status = 'sent' where clinic_id = $1 and status = 'void' and not (id = any($2)) returning id`, [clinic.id, made])
    ).rows.map((r) => r.id as string);
    await go(page, `${C}/invoices?status=cancelled`);
    await page.locator("[data-delete-cancelled]").click();
    await page.getByRole("dialog").getByRole("button", { name: /Delete cancelled invoices/ }).click();
    await page.waitForFunction(`!document.querySelector("[data-delete-cancelled]")`, undefined, { timeout: 60000 });
    const after = (await db.query(`select id from invoices where id = any($1)`, [[D, F]])).rows.map((r) => r.id);
    check("Delete cancelled clears the cancelled invoices", !after.includes(D));
    check("and leaves the one filed with JoFotara", after.includes(F));
    check("the button goes once nothing is left to delete", !(await page.locator("[data-delete-cancelled]").count()));
    check("B, never cancelled, is untouched", (await db.query(`select status from invoices where id = $1`, [B])).rows[0]?.status === "paid");

    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    if (parked.length) await db.query(`update invoices set status = 'void' where id = any($1)`, [parked]);
    await db.query(`delete from invoices where id = any($1)`, [made]).catch(() => {});
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
