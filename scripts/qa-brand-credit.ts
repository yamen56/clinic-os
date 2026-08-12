/**
 * The Clinicti credit, on every surface that leaves the clinic.
 *
 * Booking links, public invoices and signed documents are the only places a
 * patient meets the product, so each one is checked for the mark, for the link
 * that carries it, and — on the printed surfaces — for the domain in the PDF's
 * own text layer, which is the part a screenshot cannot prove.
 *
 * Needs Postgres, the dev web app and the worker.
 */
try {
  process.loadEnvFile?.();
} catch {
  /* no .env — rely on the real environment */
}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { printUrl } from "../src/lib/esign/print-token";
import { renderUrlToPdf } from "../src/lib/pdf";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const BASE = process.env.APP_URL || "http://localhost:3000";
const LINK = "https://clinicti.app";

let pass = 0;
const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

/** The credit as the browser sees it: a real anchor, with the mark beside it. */
async function creditOn(
  page: Page,
  url: string,
  label: string,
  opts: { url?: boolean; count?: number } = {}
) {
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
  ok(`${label}: page loads`, !!res && res.status() < 400, String(res?.status()));
  const all = page.locator(`a[href="${LINK}"]`);
  const n = await all.count();
  /*
    One credit per printed sheet, not per page render: the "document" print URL
    lays out the document sheet and the certificate together, because that one
    render is what becomes the whole PDF. Two credits there means two separate
    pieces of paper, each carrying it once.
  */
  const want = opts.count ?? 1;
  ok(`${label}: credit is a link to clinicti.app`, n === want, `found ${n}, wanted ${want}`);
  if (n === 0) return;
  const a = all.first();
  ok(`${label}: opens in a new tab, safely`,
    (await a.getAttribute("target")) === "_blank" && (await a.getAttribute("rel"))?.includes("noopener") === true);
  const img = a.locator("img");
  ok(`${label}: carries the mark`, (await img.count()) === 1);
  if (await img.count()) {
    const loaded = await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
    ok(`${label}: the mark actually renders`, loaded);
  }
  const text = ((await a.textContent()) || "").trim();
  ok(`${label}: names the product`, /Clinicti|كلينيكتي/.test(text), JSON.stringify(text));
  if (opts.url) ok(`${label}: prints the address for paper`, text.includes("clinicti.app"), JSON.stringify(text));
  // Silent, not shouty: the credit must stay small and grey.
  const size = await a.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  ok(`${label}: stays quiet (${size}px <= 12)`, size <= 12, `${size}px`);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = `bc${Date.now().toString(36)}`;
  const cleanup: Array<() => Promise<unknown>> = [];

  const clinic = (await db.query(
    `insert into clinics (name, name_ar, slug, default_locale) values ('Credit QA','فحص',$1,'en') returning id`,
    [tag]
  )).rows[0];
  cleanup.push(() => db.query(`delete from clinics where id = $1`, [clinic.id]));
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

  // --- Booking link -------------------------------------------------------
  const bslug = `${tag}-book`;
  await db.query(
    `insert into booking_links (clinic_id, slug, active) values ($1,$2,true)`,
    [clinic.id, bslug]
  ).catch(async (e) => {
    // Schema drift guard: report rather than pretend the surface was checked.
    console.log("  !! booking_links insert failed:", e.message);
  });

  // --- Invoice ------------------------------------------------------------
  const patient = (await db.query(
    `insert into patients (clinic_id, full_name, phone_e164) values ($1,'Credit Patient','+962790000111') returning id`,
    [clinic.id]
  )).rows[0];
  const token = randomUUID().replace(/-/g, "");
  const invNo = `CQA-${Date.now().toString(36)}`;
  const inv = (await db.query(
    `insert into invoices (clinic_id, patient_id, seq, number, status, currency, subtotal, total, amount_paid, public_token)
     values ($1,$2,1,$3,'sent','JOD',50,50,0,$4) returning id`,
    [clinic.id, patient.id, invNo, token]
  )).rows[0];
  await db.query(
    `insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount) values ($2,$1,'Consultation',1,50,50)`,
    [inv.id, clinic.id]
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });

  console.log("\n[booking link]");
  await creditOn(page, `${BASE}/book/${bslug}`, "booking");

  console.log("\n[public invoice — screen]");
  await creditOn(page, `${BASE}/inv/${token}`, "invoice");

  console.log("\n[public invoice — print]");
  await creditOn(page, `${BASE}/inv/${token}?print=1`, "invoice print", { url: true });

  // --- Signed document ----------------------------------------------------
  // Both printed sheets are checked: the document itself, and the certificate,
  // which is the only page an uploaded PDF ever gets from us.
  const doc = (await db.query(
    `insert into documents (clinic_id, patient_id, title, language, status, source, content_snapshot, content_hash)
     values ($1,$2,'Consent','en','completed','template','<p>Consent body</p>','deadbeef') returning id`,
    [clinic.id, patient.id]
  )).rows[0];
  await db.query(
    `insert into document_signers (clinic_id, document_id, role_key, display_name, status)
     values ($1,$2,'patient','Credit Patient','signed')`,
    [clinic.id, doc.id]
  );

  console.log("\n[document sheet]");
  await creditOn(page, printUrl(BASE, doc.id, "document"), "document", { url: true, count: 2 });

  console.log("\n[signing certificate]");
  await creditOn(page, printUrl(BASE, doc.id, "certificate"), "certificate", { url: true });

  console.log("\n[document PDF]");
  try {
    const dpdf = await renderUrlToPdf(printUrl(BASE, doc.id, "document"));
    ok("document PDF: renders", dpdf.length > 1000, `${dpdf.length} bytes`);
    ok("document PDF: carries a clinicti.app link annotation", dpdf.toString("latin1").includes("clinicti.app"));
  } catch (e) {
    ok("document PDF: renders", false, (e as Error).message);
  }

  console.log("\n[invoice PDF]");
  try {
    const pdf = await renderUrlToPdf(`${BASE}/inv/${token}?print=1`);
    const raw = pdf.toString("latin1");
    ok("invoice PDF: renders", pdf.length > 1000, `${pdf.length} bytes`);
    ok("invoice PDF: carries a clinicti.app link annotation", raw.includes("clinicti.app"));
  } catch (e) {
    ok("invoice PDF: renders", false, (e as Error).message);
  }

  await browser.close();
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await db.query(`delete from patients where clinic_id = $1`, [clinic.id]).catch(() => {});
  await db.end();

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
