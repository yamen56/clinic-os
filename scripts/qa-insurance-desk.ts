/**
 * Insurance at the desk: the company's terms filling in its share, lapsed
 * cover caught before the claim, the claims screen worked in bulk, the monthly
 * statement, and the patient file that shows all of it.
 *
 * Through the real screens and actions, because the rules live there: who may
 * touch which claim, what a paid claim does to the ledger, which date a cover
 * is measured against.
 *
 *   npx tsx scripts/qa-insurance-desk.ts      (dev server on :3000)
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium } from "playwright";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { insurerShareFor, coverState, ageBucket, coverHolds } from "../src/lib/insurance";
import { statusesFor } from "../src/lib/claims";
import { financeTabs } from "../src/lib/finance";
import { en } from "../src/lib/i18n/en";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

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

// A 1×1 PNG, for the insurance card photo.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

async function main() {
  /* ================================================================== */
  console.log("\n[the arithmetic]");
  check("80% of 100 is 80", insurerShareFor(100, { percent: 80, cap: null }) === 80);
  check("held under the cap", insurerShareFor(100, { percent: 80, cap: 50 }) === 50);
  check("never more than the invoice", insurerShareFor(30, { percent: 100, cap: 500 }) === 30);
  check("no rule, no share", insurerShareFor(100, { percent: null, cap: 50 }) === 0);
  check("to the fil", insurerShareFor(33.33, { percent: 80, cap: null }) === 26.66);
  check("no company is self-paying", coverState(null, null, "2026-10-05") === "none");
  check("no end date counts as covered", coverState("x", null, "2026-10-05") === "active");
  check("a lapsed date is expired", coverState("x", "2026-10-04", "2026-10-05") === "expired");
  check("the last day still counts", coverHolds("x", "2026-10-05", "2026-10-05"));
  check("within a month it is expiring", coverState("x", "2026-10-30", "2026-10-05") === "expiring");
  check("ages bucket by the invoice date", ageBucket("2026-06-01", "2026-10-05") === "older" && ageBucket("2026-09-20", "2026-10-05") === "d30");
  check("open means everything not settled", statusesFor("open").join() === "to_submit,submitted,approved,rejected");
  // Claims answer to the Insurance switch, not to Invoices (2026-10-06).
  const caps = { invoices: true, insurance: true } as never;
  check("a cash-only clinic has no claims tab", !financeTabs({ caps, hasEarnings: false, fullControl: false }).includes("claims"));
  check("one with a company does", financeTabs({ caps, hasEarnings: false, fullControl: false, hasInsurers: true }).includes("claims"));
  check(
    "but not for somebody without Insurance",
    !financeTabs({ caps: { invoices: true } as never, hasEarnings: false, fullControl: false, hasInsurers: true }).includes("claims")
  );

  /* ================================================================== fixtures */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const slug = `qains${Date.now().toString(36)}`;
  const email = `owner-${slug}@test.local`;
  const today = DateTime.now().setZone("Asia/Amman");
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency)
       values ('QA Insure Desk', 'تأمين', $1, 'en', 'Asia/Amman', 'JOD') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  await db.query(`select seed_esign_defaults($1)`, [clinicId]);
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [clinicId]);
  const userId = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'en') returning id`,
      [email, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'other', true, '{"level":"full"}')`,
    [clinicId, userId]
  );
  await db.query(
    `insert into services (clinic_id, name, duration_min, price, fee_code) values ($1, 'QA Checkup', 30, 100, 'D0150')`,
    [clinicId]
  );
  const health = (
    await db.query(
      `insert into insurers (clinic_id, name, code, coverage_percent, coverage_cap)
       values ($1, 'QA Health', 'QH', 80, 50) returning id`,
      [clinicId]
    )
  ).rows[0].id as string;
  const mutual = (
    await db.query(`insert into insurers (clinic_id, name, code) values ($1, 'QA Mutual', 'QM') returning id`, [clinicId])
  ).rows[0].id as string;
  const mkPatient = async (name: string, phone: string, insurer: string, until: string | null, nid: string) =>
    (
      await db.query(
        `insert into patients (clinic_id, full_name, phone_e164, source, insurer_id, insurance_no,
                               insurance_valid_until, custom_fields)
         values ($1, $2, $3, 'staff', $4, 'POL-' || right($3, 4), $5, jsonb_build_object('national_id', $6::text))
         returning id`,
        [clinicId, name, phone, insurer, until, nid]
      )
    ).rows[0].id as string;
  const covered = await mkPatient("Hala Covered", "+962790003001", health, today.plus({ days: 200 }).toISODate(), "9881112223");
  const lapsed = await mkPatient("Omar Lapsed", "+962790003002", health, "2020-01-01", "9881112224");
  const noTerms = await mkPatient("Lina NoTerms", "+962790003003", mutual, null, "9881112225");
  console.log(`\n✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const visible = async () => (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  const invoiceOf = async (patientId: string) =>
    (
      await db.query(
        `select id, insurer_id, insurer_amount, claim_status, total from invoices
          where patient_id = $1 order by created_at desc limit 1`,
        [patientId]
      )
    ).rows[0];
  const raiseInvoice = async (patientId: string) => {
    await page.goto(`${BASE}/c/${slug}/invoices/new?patient=${patientId}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /QA Checkup/ }).first().click();
    await page.getByRole("button", { name: en.common.create, exact: true }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 120_000 });
    await page.waitForLoadState("networkidle");
    return invoiceOf(patientId);
  };

  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });

    /* ================================================================== */
    console.log("\n[the company's terms fill in its share]");
    const a = await raiseInvoice(covered);
    check("an insured patient's invoice names the company", a?.insurer_id === health);
    check("and takes its share under the clinic's terms — 80%, at most 50", Number(a?.insurer_amount) === 50, String(a?.insurer_amount));
    check("ready to submit", a?.claim_status === "to_submit", a?.claim_status);
    const lineCode = (await db.query(`select fee_code from invoice_items where invoice_id = $1`, [a.id])).rows[0]?.fee_code;
    check("with the service's billing code on the line", lineCode === "D0150", lineCode);

    const b = await raiseInvoice(lapsed);
    check("lapsed cover takes nothing", Number(b?.insurer_amount) === 0, String(b?.insurer_amount));
    check("but still names the company, in case the patient renewed", b?.insurer_id === health);
    const bText = await visible();
    check(
      "and the claim says the cover had expired",
      bText.includes(en.insurers.coverExpiredOn.split("{date}")[0].trim()),
      ""
    );

    const c = await raiseInvoice(noTerms);
    check("a company without terms leaves the share for a person", Number(c?.insurer_amount) === 0);
    await page.locator("main select").filter({ has: page.locator(`option[value="${health}"]`) }).last().selectOption(health);
    const suggested = await page.getByLabel(en.insurers.covered).first().inputValue();
    check("picking a company with terms suggests its share", suggested === "50", suggested);

    /* ================================================================== */
    console.log("\n[setting a company's terms]");
    await page.goto(`${BASE}/c/${slug}/settings/insurers`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /QA Mutual/ }).first().click();
    await page.getByRole("dialog").waitFor({ timeout: 30_000 });
    await page.getByLabel(en.insurers.coveragePercent).fill("60");
    await page.getByRole("dialog").getByRole("button", { name: en.common.save }).click();
    // The dialog closes when the action answers — the save, not a guess at how long it takes.
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    const terms = (await db.query(`select coverage_percent from insurers where id = $1`, [mutual])).rows[0];
    check("the terms are saved", Number(terms.coverage_percent) === 60, String(terms.coverage_percent));
    check("and the list says them", (await visible()).includes(en.insurers.ruleCovers.replace("{pct}", "60")));

    /* ================================================================== */
    console.log("\n[the claims screen]");
    await page.goto(`${BASE}/c/${slug}/claims`);
    await page.waitForLoadState("networkidle");
    const claimsText = await visible();
    check("the money section has a claims tab", (await page.getByRole("tab", { name: en.claims.tab }).count()) > 0);
    check("every open claim is listed", ["Hala Covered", "Omar Lapsed", "Lina NoTerms"].every((n) => claimsText.includes(n)));
    check("with the national number an insurer matches on", claimsText.includes("9881112223"));
    check("the lapsed one is flagged", claimsText.includes(en.claims.coverLapsedShort));
    check("and what each company owes is summed", claimsText.includes("QA Health") && claimsText.includes(en.claims.awaiting));

    const tick = async (name: string) =>
      page.locator("li", { hasText: name }).locator('input[type="checkbox"]').check();

    await tick("Hala Covered");
    await page.getByRole("button", { name: en.claims.markSubmitted, exact: true }).click();
    await page.waitForTimeout(2000);
    const sub = (await db.query(`select claim_status, claim_submitted_at from invoices where id = $1`, [a.id])).rows[0];
    check("marked submitted, with the day it went", sub.claim_status === "submitted" && Boolean(sub.claim_submitted_at), sub.claim_status);

    await page.waitForLoadState("networkidle");
    await tick("Hala Covered");
    await page.getByRole("button", { name: en.claims.markPaid, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(en.claims.paidReference).fill("TRX-77");
    await dialog.getByRole("button", { name: en.claims.markPaid, exact: true }).click();
    await page.waitForTimeout(2500);
    const pay = (
      await db.query(`select amount, method, reference from payments where invoice_id = $1`, [a.id])
    ).rows;
    check("the company's payment is recorded on the invoice", pay.length === 1 && Number(pay[0].amount) === 50, JSON.stringify(pay));
    check("by transfer, naming the company and the reference", pay[0]?.method === "transfer" && /QA Health · TRX-77/.test(pay[0]?.reference ?? ""), pay[0]?.reference);
    const aAfter = (await db.query(`select claim_status, amount_paid from invoices where id = $1`, [a.id])).rows[0];
    check("and the claim is paid", aAfter.claim_status === "paid" && Number(aAfter.amount_paid) === 50, JSON.stringify(aAfter));
    const msgs = await db.query(`select count(*)::int n from messages m join conversations cv on cv.id = m.conversation_id where cv.patient_id = $1`, [covered]);
    check("the patient is not messaged about it", msgs.rows[0].n === 0, `${msgs.rows[0].n}`);

    await page.waitForLoadState("networkidle");
    await tick("Lina NoTerms");
    await page.getByRole("button", { name: en.claims.markRejected, exact: true }).click();
    await page.getByRole("dialog").getByLabel(en.claims.rejectReason).fill("Missing diagnosis code");
    await page.getByRole("dialog").getByRole("button", { name: en.claims.markRejected, exact: true }).click();
    await page.waitForTimeout(2000);
    const rej = (await db.query(`select claim_status, claim_note from invoices where id = $1`, [c.id])).rows[0];
    check("a rejection keeps its reason", rej.claim_status === "rejected" && rej.claim_note === "Missing diagnosis code", JSON.stringify(rej));

    /* ================================================================== */
    console.log("\n[the monthly statement]");
    const res = await page.request.get(`${BASE}/api/c/${slug}/claims/export?status=all&insurer=${health}`);
    check("it downloads", res.status() === 200 && /.xlsx/.test(res.headers()["content-disposition"] ?? ""), res.headers()["content-disposition"] ?? String(res.status()));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.body()) as never);
    const sheet = wb.worksheets[0];
    const rowsText = sheet.getSheetValues().map((r) => JSON.stringify(r)).join("\n");
    check("one row per claim, with the national number and policy", rowsText.includes("9881112223") && rowsText.includes("POL-3001"));
    check("only this company's", !rowsText.includes("Lina NoTerms"));
    check("with the billing codes", rowsText.includes("D0150"));
    check("and a totals row", rowsText.includes(en.claims.sheet.totals));
    check("plus a sheet of service lines", wb.worksheets.length === 2 && wb.worksheets[1].rowCount >= 3, String(wb.worksheets[1]?.rowCount));
    const exported = await db.query(`select count(*)::int n from audit_log where clinic_id = $1 and action = 'claims.export'`, [clinicId]);
    check("and the export is audited", exported.rows[0].n === 1);

    /* ================================================================== */
    console.log("\n[the patient file]");
    await page.goto(`${BASE}/c/${slug}/patients/${covered}`);
    await page.waitForLoadState("networkidle");
    const fileText = await visible();
    check("insurance has its own card", fileText.includes(en.insurers.card.title));
    check("saying the cover holds, and until when", fileText.includes(en.insurers.card.activeUntil.split("{date}")[0].trim()));
    check("and the company's terms", fileText.includes("QA Health pays 80% of each invoice"));
    check("the header names the company", (await page.locator("main").locator("text=QA Health").count()) > 0);
    check(
      "the claims on this patient are listed",
      fileText.includes(en.insurers.card.claims) && fileText.includes(en.insurers.claimStatus.paid)
    );
    const nidValues = await page.locator("main input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    check("the national number sits with the details", nidValues.includes("9881112223"));

    const uploaded = page.waitForResponse((r) => r.url().includes(`/patients/${covered}/files`) && r.request().method() === "POST", { timeout: 120_000 });
    await page.locator('input[type="file"][accept="image/*,application/pdf"]').setInputFiles({
      name: "card-front.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    const up = await uploaded;
    check("the card photo uploads", up.status() === 200, `${up.status()} ${(await up.text()).slice(0, 120)}`);
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle");
    const card = await db.query(`select count(*)::int n from patient_files where patient_id = $1 and kind = 'insurance_card'`, [covered]);
    check("a photo of the card is filed as the card", card.rows[0].n === 1, `${card.rows[0].n}`);
    check("and shown on the card", (await page.locator('main img[alt="card-front.png"]').count()) === 1);

    await page.goto(`${BASE}/c/${slug}/patients/${lapsed}`);
    await page.waitForLoadState("networkidle");
    const lapsedText = await visible();
    check("lapsed cover is said in red on the file", lapsedText.includes(en.insurers.card.expired.split("{date}")[0].trim()));
    check("and in the header", lapsedText.includes(en.insurers.card.expiredShort));

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${BASE}/c/${slug}/claims`);
      await page.waitForLoadState("networkidle");
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      await page.waitForTimeout(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`the claims screen fits a ${width}px phone`, over <= 1, `${over}px overflow`);
    }
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinicId]);
    await db.query(`delete from users where id = $1`, [userId]);
    await db.end();
  }

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
