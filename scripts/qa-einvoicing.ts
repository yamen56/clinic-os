/**
 * Per-line tax, and filing invoices with JoFotara.
 *
 * Two things are being protected here and they pull in opposite directions.
 *
 * The first is the six clinics who never asked for any of this: their invoices
 * must behave exactly as they did yesterday, nothing queued, nothing blocked,
 * no new column with an opinion in it. That is the assertion this file exists
 * for above all others.
 *
 * The second is that a clinic which *has* switched it on can never end up with
 * an unreported sale or an unstamped PDF in a patient's hand — while still
 * being able to take money when the tax authority is unreachable, which it will
 * be sometimes.
 *
 * Nothing here touches the real ISTD endpoint. Filing an invoice is a recorded,
 * irreversible act; scripts/mock-jofotara.ts stands in, and it validates the
 * document rather than rubber-stamping it.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium } from "playwright";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { computeInvoice, taxBreakdown, round2 } from "../src/lib/invoices";
import { buildInvoiceXml, encodeInvoice, totalsOf, SUBTYPE, DOC_INVOICE, DOC_CREDIT_NOTE } from "../src/lib/einvoice/ubl";
import { EMPTY_SETTINGS, isReady, missingFields } from "../src/lib/einvoice/settings";
import { startMockJofotara, validateUbl } from "./mock-jofotara";
import { ar } from "../src/lib/i18n/ar";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const MOCK = `http://127.0.0.1:${process.env.MOCK_JOFOTARA_PORT || 4111}`;

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

async function main() {
  const { submitEinvoice } = await import("../worker/einvoice");
  const server = await startMockJofotara();
  process.env.JOFOTARA_BASE_URL = MOCK;

  const db = new Client({ connectionString: PG });
  await db.connect();

  /* ================================================================== */
  console.log("\n[folding an invoice up from its lines]");

  const mixed = computeInvoice([
    // The case the old model could not express at all: an exempt consultation
    // and a taxable procedure on the same visit.
    { description: "Consultation", qty: 1, unitPrice: 30, taxCategory: "E", taxRate: 0 },
    { description: "Whitening", qty: 1, unitPrice: 100, taxCategory: "S", taxRate: 16 },
  ]);
  check("subtotal is the sum of the lines", mixed.subtotal === 130, String(mixed.subtotal));
  check("only the taxable line is taxed", mixed.taxAmount === 16, String(mixed.taxAmount));
  check("the total follows", mixed.total === 146, String(mixed.total));
  /*
    The legacy header rate. Nothing displays from it any more, but it is `not
    null` and still stored, so it has to mean something defensible: the rate when
    exactly one is in play — an exempt line alongside a 16% line is still a 16%
    invoice — and 0 when two different rates make a single number a lie.
  */
  check("one taxed rate is still reported on the header", mixed.taxRate === 16, `taxRate=${mixed.taxRate}`);
  const twoRates = computeInvoice([
    { description: "A", qty: 1, unitPrice: 100, taxCategory: "S", taxRate: 16 },
    { description: "B", qty: 1, unitPrice: 100, taxCategory: "S", taxRate: 4 },
  ]);
  check("two rates report none", twoRates.taxRate === 0, `taxRate=${twoRates.taxRate}`);
  check("but both are still charged", twoRates.taxAmount === 20, String(twoRates.taxAmount));

  const discounted = computeInvoice([
    { description: "A", qty: 3, unitPrice: 33.33, discountAmount: 10, taxCategory: "S", taxRate: 16 },
  ]);
  check(
    "a per-line discount comes off before tax",
    discounted.lines[0].net === 89.99 && discounted.taxAmount === round2(89.99 * 0.16),
    `net=${discounted.lines[0].net} tax=${discounted.taxAmount}`
  );
  check(
    "the header is exactly the sum of the stored lines",
    discounted.subtotal === discounted.lines[0].amount &&
      discounted.discount === discounted.lines[0].discount &&
      discounted.taxAmount === discounted.lines[0].tax
  );

  const overDiscounted = computeInvoice([
    { description: "A", qty: 1, unitPrice: 20, discountAmount: 500, taxCategory: "S", taxRate: 16 },
  ]);
  check(
    "a discount cannot exceed its own line",
    overDiscounted.total === 0 && overDiscounted.lines[0].net === 0,
    String(overDiscounted.total)
  );

  const strayRate = computeInvoice([
    { description: "A", qty: 1, unitPrice: 50, taxCategory: "E", taxRate: 16 },
  ]);
  check(
    "an exempt line cannot carry a rate",
    strayRate.taxAmount === 0 && strayRate.lines[0].taxRate === 0,
    `tax=${strayRate.taxAmount}`
  );

  const rows = taxBreakdown(mixed.lines);
  check("the breakdown separates the categories", rows.length === 2, `${rows.length} rows`);

  /* ================================================================== */
  console.log("\n[what the migration did to invoices that already existed]");

  const drift = await db.query(`
    select count(*)::int n from (
      select i.id from invoices i join invoice_items ii on ii.invoice_id = i.id
       group by i.id, i.discount_amount, i.tax_amount
      having abs(i.discount_amount - sum(ii.discount_amount)) > 0.005
          or abs(i.tax_amount - sum(ii.tax_amount)) > 0.005
    ) x`);
  check(
    "every historical invoice still foots to its lines",
    drift.rows[0].n === 0,
    `${drift.rows[0].n} that do not`
  );
  const noDate = await db.query(`select count(*)::int n from invoices where issue_date is null`);
  check("and every one has an issue date", noDate.rows[0].n === 0, `${noDate.rows[0].n} without`);

  /* ================================================================== */
  console.log("\n[the document ISTD receives]");

  const settings = {
    ...EMPTY_SETTINGS,
    enabled: true,
    taxpayerType: "general" as const,
    registeredName: "Rima Dental",
    taxNumber: "12345678",
    incomeSourceSequence: "9911",
    clientId: "cid",
    secretKey: "sk",
  };
  const xmlArgs = {
    settings,
    uuid: randomUUID(),
    number: "RIMA-2026-0001",
    icv: 1,
    issueDate: "2026-08-24",
    currency: "JOD",
    documentType: DOC_INVOICE as typeof DOC_INVOICE,
    paid: true,
    buyerName: "سارة عبدالله",
    buyerPhone: "+962790000001",
    lines: mixed.lines.map((l, i) => ({
      description: ["Consultation", "Whitening"][i],
      qty: 1,
      unitPrice: [30, 100][i],
      amount: l.amount,
      discount: l.discount,
      taxCategory: l.taxCategory,
      taxRate: l.taxRate,
      tax: l.tax,
    })),
  };
  const xml = buildInvoiceXml(xmlArgs);

  check("it is valid against the receiving end's own checks", validateUbl(xml) === null, validateUbl(xml) ?? "");
  check("the seller's tax number is on it", xml.includes("<cbc:CompanyID>12345678</cbc:CompanyID>"));
  check("so is the registered name", xml.includes("Rima Dental"));
  check("Arabic survives the round trip", xml.includes("سارة عبدالله"));
  check("both categories are declared", xml.includes(">E<") && xml.includes(">S<"));
  check(
    "a general taxpayer's invoice is cash-coded 012",
    xml.includes(`name="${SUBTYPE.general.cash}"`),
    SUBTYPE.general.cash
  );
  check(
    "an unpaid one is receivable-coded 022",
    buildInvoiceXml({ ...xmlArgs, paid: false }).includes(`name="${SUBTYPE.general.receivable}"`)
  );
  check(
    "an income taxpayer's invoice uses its own codes",
    buildInvoiceXml({ ...xmlArgs, settings: { ...settings, taxpayerType: "income" } }).includes(
      `name="${SUBTYPE.income.cash}"`
    )
  );
  check(
    "an income taxpayer sends no activity number",
    !buildInvoiceXml({
      ...xmlArgs,
      settings: { ...settings, taxpayerType: "income" },
    }).includes("SellerSupplierParty")
  );
  const t2 = totalsOf(xmlArgs.lines);
  check(
    "the totals block agrees with the invoice",
    t2.net === 130 && t2.tax === 16 && t2.gross === 146,
    `${t2.net}/${t2.tax}/${t2.gross}`
  );
  check(
    "a name with an ampersand cannot end the document early",
    buildInvoiceXml({ ...xmlArgs, buyerName: 'A & B "C" <D>' }).includes("A &amp; B &quot;C&quot; &lt;D&gt;")
  );
  check("base64 round-trips", Buffer.from(encodeInvoice(xml), "base64").toString("utf8") === xml);

  console.log("\n[a registration that is not finished yet]");
  check("an empty one is not ready", !isReady({ ...EMPTY_SETTINGS, enabled: true }));
  check(
    "and says which fields are missing",
    missingFields({ ...EMPTY_SETTINGS, enabled: true }).includes("taxNumber")
  );
  check(
    "an income taxpayer needs no activity number",
    !missingFields({ ...settings, taxpayerType: "income", incomeSourceSequence: "" }).includes(
      "incomeSourceSequence"
    )
  );
  check("a general one does", missingFields({ ...settings, incomeSourceSequence: "" }).includes("incomeSourceSequence"));
  check("a complete registration is ready", isReady(settings));

  /* ================================================================== fixtures */
  const stamp = Date.now().toString(36);
  const mk = async (slug: string, einvoicing: boolean) => {
    const clinic = (
      await db.query(
        `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix, features)
         values ('QA Einv','فوترة',$1,'ar','Asia/Amman','JOD','QAE',$2) returning id`,
        [slug, JSON.stringify({ einvoicing })]
      )
    ).rows[0];
    await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1,'connected')`, [clinic.id]);
    const user = (
      await db.query(
        // Arabic, like the product's default and the rest of the suite — the
        // assertions below read the Arabic dictionary.
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Owner','ar') returning id`,
        [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
      )
    ).rows[0];
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
       values ($1,$2,'receptionist',true,'{"level":"full"}')`,
      [clinic.id, user.id]
    );
    const patient = (
      await db.query(
        `insert into patients (clinic_id, full_name, phone_e164, source)
         values ($1,'QA Patient','+96279${Math.floor(1000000 + Math.random() * 8999999)}','staff') returning id`,
        [clinic.id]
      )
    ).rows[0];
    if (einvoicing) {
      await db.query(
        `insert into clinic_einvoice_settings
           (clinic_id, enabled, taxpayer_type, registered_name, tax_number, income_source_sequence, client_id, secret_key)
         values ($1, true, 'general', 'QA Einv', '99887766', '4321', 'cid', 'sk')`,
        [clinic.id]
      );
    }
    return { id: clinic.id as string, slug, userEmail: `owner-${slug}@test.local`, patient: patient.id as string };
  };

  const filer = await mk(`qaeinv${stamp}`, true);
  const bystander = await mk(`qaplain${stamp}`, false);

  let seq = 0;
  const makeInvoice = async (clinicId: string, patientId: string, opts: { unitPrice: number; taxRate?: number }) => {
    seq++;
    const line = computeInvoice([
      { description: "Service", qty: 1, unitPrice: opts.unitPrice, taxCategory: opts.taxRate ? "S" : "O", taxRate: opts.taxRate ?? 0 },
    ]);
    const inv = (
      await db.query(
        `insert into invoices (clinic_id, patient_id, seq, number, status, currency, subtotal, discount_amount,
                               tax_rate, tax_amount, total, issue_date)
         values ($1,$2,$3,$4,'sent','JOD',$5,$6,$7,$8,$9, current_date) returning id`,
        [clinicId, patientId, seq, `QAE-2026-${String(seq).padStart(4, "0")}`,
         line.subtotal, line.discount, line.taxRate, line.taxAmount, line.total]
      )
    ).rows[0];
    await db.query(
      `insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount,
                                  discount_amount, tax_category, tax_rate, tax_amount, sort)
       values ($1,$2,'Service',1,$3,$4,0,$5,$6,$7,0)`,
      [clinicId, inv.id, opts.unitPrice, line.lines[0].amount, line.lines[0].taxCategory,
       line.lines[0].taxRate, line.lines[0].tax]
    );
    return inv.id as string;
  };
  console.log(`\n✓ fixtures: ${filer.slug} files, ${bystander.slug} does not`);

  /* ================================================================== */
  console.log("\n[a clinic that never asked for any of this]");

  const plainInv = await makeInvoice(bystander.id, bystander.patient, { unitPrice: 40 });
  const { enqueueEinvoiceSubmit } = await import("../src/lib/einvoice/jobs");
  /*
    A Client where the code wants a PoolClient. Only `.query` is ever called, and
    a superuser connection is what a test needs here — it has to see across both
    fixture clinics to prove the one that never opted in is untouched.
  */
  const dbAsClient = db as never;
  const queued = await enqueueEinvoiceSubmit(dbAsClient, bystander.id, plainInv, "paid");
  check("nothing is queued for it", queued === false);
  const plainState = await db.query(`select einvoice_status from invoices where id = $1`, [plainInv]);
  check(
    "and its invoice stays out of the whole mechanism",
    plainState.rows[0].einvoice_status === "not_required",
    plainState.rows[0].einvoice_status
  );
  const plainJobs = await db.query(
    `select count(*)::int n from jobs where clinic_id = $1 and kind = 'einvoice:submit'`,
    [bystander.id]
  );
  check("no job row exists for it at all", plainJobs.rows[0].n === 0);

  /* ================================================================== */
  console.log("\n[filing, and filing only once]");

  const invA = await makeInvoice(filer.id, filer.patient, { unitPrice: 100, taxRate: 16 });
  const first = await enqueueEinvoiceSubmit(dbAsClient, filer.id, invA, "paid");
  const second = await enqueueEinvoiceSubmit(dbAsClient, filer.id, invA, "delivered");
  check("the first trigger queues it", first === true);
  check("a second trigger does not queue it again", second === false);
  const jobCount = await db.query(
    `select count(*)::int n from jobs where dedupe_key = $1`,
    [`einvoice:submit:${invA}`]
  );
  check("there is exactly one job", jobCount.rows[0].n === 1, `${jobCount.rows[0].n}`);

  await submitEinvoice(invA, { attempts: 1, maxAttempts: 5, isLastAttempt: false });
  const doneA = (
    await db.query(
      `select einvoice_status, einvoice_uuid, einvoice_qr, einvoice_payment_method, pdf_path
         from invoices where id = $1`,
      [invA]
    )
  ).rows[0];
  check("it comes back filed", doneA.einvoice_status === "submitted", doneA.einvoice_status);
  check("with a QR to print", Boolean(doneA.einvoice_qr));
  check("and the UUID we sent", Boolean(doneA.einvoice_uuid));
  check(
    "an unpaid invoice is filed as receivable",
    doneA.einvoice_payment_method === "022",
    doneA.einvoice_payment_method
  );

  const invPaid = await makeInvoice(filer.id, filer.patient, { unitPrice: 50, taxRate: 16 });
  await db.query(`update invoices set amount_paid = total, status = 'paid' where id = $1`, [invPaid]);
  await enqueueEinvoiceSubmit(dbAsClient, filer.id, invPaid, "paid");
  await submitEinvoice(invPaid, { attempts: 1, maxAttempts: 5, isLastAttempt: false });
  const donePaid = (
    await db.query(`select einvoice_payment_method from invoices where id = $1`, [invPaid])
  ).rows[0];
  check("a settled one is filed as cash", donePaid.einvoice_payment_method === "012", donePaid.einvoice_payment_method);

  const events = await db.query(
    `select kind from invoice_einvoice_events where invoice_id = $1 order by created_at`,
    [invA]
  );
  check(
    "the trail records what happened",
    events.rows.map((r) => r.kind).join(",") === "queued,accepted",
    events.rows.map((r) => r.kind).join(",")
  );

  /* ================================================================== */
  console.log("\n[when the tax authority is having a bad day]");

  const invDown = await makeInvoice(filer.id, filer.patient, { unitPrice: 25, taxRate: 16 });
  await enqueueEinvoiceSubmit(dbAsClient, filer.id, invDown, "paid");
  await fetch(`${MOCK}/__fault`, {
    method: "POST",
    body: JSON.stringify({ status: 503, body: "upstream down", times: 99 }),
  });

  let threw = false;
  try {
    await submitEinvoice(invDown, { attempts: 1, maxAttempts: 5, isLastAttempt: false });
  } catch {
    threw = true;
  }
  check("a 5xx is thrown so the runner retries it", threw);
  const midFlight = (await db.query(`select einvoice_status from invoices where id = $1`, [invDown])).rows[0];
  check("and the invoice stays in flight", midFlight.einvoice_status === "pending", midFlight.einvoice_status);

  await submitEinvoice(invDown, { attempts: 5, maxAttempts: 5, isLastAttempt: true });
  const exhausted = (
    await db.query(`select einvoice_status, einvoice_error from invoices where id = $1`, [invDown])
  ).rows[0];
  check("the last attempt gives up rather than looping", exhausted.einvoice_status === "failed", exhausted.einvoice_status);
  check("and keeps the reason", Boolean(exhausted.einvoice_error), exhausted.einvoice_error ?? "");
  const told = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'einvoice_failed'`,
    [filer.id]
  );
  check("somebody is told, once", told.rows[0].n === 1, `${told.rows[0].n}`);

  await fetch(`${MOCK}/__reset`, { method: "POST" });

  console.log("\n[when the invoice itself is wrong]");
  const invBad = await makeInvoice(filer.id, filer.patient, { unitPrice: 30, taxRate: 16 });
  await enqueueEinvoiceSubmit(dbAsClient, filer.id, invBad, "paid");
  await fetch(`${MOCK}/__fault`, {
    method: "POST",
    body: JSON.stringify({ status: 400, body: '{"EINV_RESULTS":{"ERRORS":[{"EINV_MESSAGE":"bad tax number"}]}}', times: 99 }),
  });
  let threwOn400 = false;
  try {
    await submitEinvoice(invBad, { attempts: 1, maxAttempts: 5, isLastAttempt: false });
  } catch {
    threwOn400 = true;
  }
  check("a rejection is not retried — it would be rejected identically", !threwOn400);
  const rejected = (
    await db.query(`select einvoice_status, einvoice_error from invoices where id = $1`, [invBad])
  ).rows[0];
  check("it fails immediately", rejected.einvoice_status === "failed", rejected.einvoice_status);
  check(
    "and the tax authority's own words are kept",
    String(rejected.einvoice_error).includes("bad tax number"),
    rejected.einvoice_error ?? ""
  );
  await fetch(`${MOCK}/__reset`, { method: "POST" });

  const { requeueEinvoiceSubmit } = await import("../src/lib/einvoice/jobs");
  const requeued = await requeueEinvoiceSubmit(dbAsClient, filer.id, invBad);
  check("a failed invoice can be filed again by hand", requeued === true);
  await submitEinvoice(invBad, { attempts: 1, maxAttempts: 5, isLastAttempt: false });
  const fixed = (await db.query(`select einvoice_status from invoices where id = $1`, [invBad])).rows[0];
  check("and succeeds once the fault is gone", fixed.einvoice_status === "submitted", fixed.einvoice_status);

  /* ================================================================== */
  console.log("\n[correcting a filed invoice]");

  const originalNumber = (await db.query(`select number from invoices where id = $1`, [invA])).rows[0].number;
  // The credit note is raised by the action, which needs a session; the shape it
  // produces is what matters, so it is built here the same way and checked.
  const creditXml = buildInvoiceXml({
    ...xmlArgs,
    documentType: DOC_CREDIT_NOTE as typeof DOC_CREDIT_NOTE,
    number: "QAE-2026-9999",
    correctsNumber: originalNumber,
    correctionReason: "Wrong amount",
  });
  check("a credit note carries 381", creditXml.includes(">381</cbc:InvoiceTypeCode>"));
  check("it names the invoice it corrects", creditXml.includes(originalNumber), originalNumber);
  check("it states a reason", creditXml.includes("Wrong amount"));
  check("and is still a valid document", validateUbl(creditXml) === null, validateUbl(creditXml) ?? "");

  /* ================================================================== */
  console.log("\n[the screens]");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', filer.userEmail);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });

    // innerText, never textContent: the whole dictionary ships in every page.
    const visible = async () => (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

    await page.goto(`${BASE}/c/${filer.slug}/settings/einvoicing`);
    await page.waitForLoadState("networkidle");
    const settingsText = await visible();
    check("the settings page is reachable for a licensed clinic", settingsText.includes(ar.einvoicing.title), "");
    check("it says the registration is complete", settingsText.includes(ar.einvoicing.ready), "");
    const pageHtml = await page.content();
    check("and the secret key is nowhere in the page", !pageHtml.includes("sk\""), "");

    await page.goto(`${BASE}/c/${bystander.slug}/settings/einvoicing`);
    await page.waitForLoadState("networkidle");
    check(
      "a clinic without the licence is redirected away",
      !page.url().includes("/einvoicing"),
      page.url()
    );

    await page.goto(`${BASE}/c/${filer.slug}/invoices/${invA}`);
    await page.waitForLoadState("networkidle");
    const detail = await visible();
    check("a filed invoice says so on its page", detail.includes(ar.einvoicing.statusSubmitted), "");

    await page.goto(`${BASE}/c/${filer.slug}/invoices/${invDown}`);
    await page.waitForLoadState("networkidle");
    const failedText = await visible();
    check("a failed one shows the reason", failedText.includes(ar.einvoicing.statusFailed), "");
    check("and offers a way to try again", failedText.includes(ar.einvoicing.retry), "");

    /*
      Cancelling a filed invoice, for real. ISTD has no delete, so the only
      correct outcome is a second document that references the first — and the
      only way to know the action does that is to press the button.
    */
    await page.goto(`${BASE}/c/${filer.slug}/invoices/${invPaid}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: ar.invoices.voidInvoice }).first().click();
    const voidDialog = page.getByRole("dialog");
    await voidDialog.waitFor({ timeout: 15_000 });
    const reasonBox = voidDialog.locator("input").first();
    check("it asks why, because the reason goes on the credit note", await reasonBox.isVisible(), "");
    await reasonBox.fill("مبلغ خاطئ");
    await voidDialog.getByRole("button", { name: ar.invoices.voidInvoice }).click();
    await page.waitForTimeout(2000);

    const note = (
      await db.query(
        `select id, number, total, einvoice_status, void_reason from invoices
          where credit_note_of = $1`,
        [invPaid]
      )
    ).rows[0];
    check("a credit note was raised against it", Boolean(note), note?.number ?? "none");
    check(
      "for the same amount as the invoice it reverses",
      note && Number(note.total) === 58,
      note ? String(note.total) : ""
    );
    check("carrying the reason", note?.void_reason === "مبلغ خاطئ", note?.void_reason ?? "");
    const noteLines = await db.query(
      `select count(*)::int n from invoice_items where invoice_id = $1`,
      [note?.id]
    );
    check("with the original's lines mirrored onto it", noteLines.rows[0].n === 1, `${noteLines.rows[0].n}`);
    const original = (
      await db.query(`select status, void_reason from invoices where id = $1`, [invPaid])
    ).rows[0];
    check("and the original is voided, not deleted", original.status === "void", original.status);

    if (note) {
      /*
        Take the job off the queue before filing it here.

        Voiding enqueues an `einvoice:submit` for the credit note, and if a
        worker is running on this machine it will claim it — from a process that
        never saw JOFOTARA_BASE_URL and so calls the real endpoint, fails, and
        leaves the invoice marked failed before this test has done anything. The
        test owns every other submission in this file by calling submitEinvoice
        directly; this makes that true here too, rather than depending on
        winning a race against a live worker.
      */
      await db.query(
        `delete from jobs where kind = 'einvoice:submit' and payload->>'invoiceId' = $1`,
        [note.id]
      );
      // And undo anything it managed before the delete landed. Resetting the
      // row is safe here precisely because the assertion below is about the
      // document this test then files, not about how it got queued.
      await db.query(
        `update invoices set einvoice_status = 'pending', einvoice_error = null where id = $1`,
        [note.id]
      );
      await submitEinvoice(note.id, { attempts: 1, maxAttempts: 5, isLastAttempt: false });
      const filedNote = (
        await db.query(`select einvoice_status, einvoice_type from invoices where id = $1`, [note.id])
      ).rows[0];
      check(
        "the credit note is filed as a 381",
        filedNote.einvoice_status === "submitted" && filedNote.einvoice_type === "381",
        `${filedNote.einvoice_status}/${filedNote.einvoice_type}`
      );
    }

    const token = (await db.query(`select public_token from invoices where id = $1`, [invA])).rows[0]
      .public_token;
    await page.goto(`${BASE}/inv/${token}`);
    await page.waitForLoadState("networkidle");
    const pub = await page.content();
    check("the public invoice carries the QR image", pub.includes("data:image/png;base64"), "");
    check("and the seller's tax number", (await page.locator("body").innerText()).includes("99887766"), "");

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${BASE}/c/${filer.slug}/settings/einvoicing`);
      await page.waitForLoadState("networkidle");
      /*
        Hide the dev overlay and let the page settle, exactly as
        qa-mobile-width does. Both matter and neither is superstition: the
        `nextjs-portal` indicator is itself wider than a 320px phone, so
        measuring with it mounted reports an overflow the product does not have;
        and `networkidle` can fire while the shell is still streaming under the
        Suspense boundary in c/[slug]/loading.tsx, which measures a half-built
        page.
      */
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      await page.waitForTimeout(250);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      check(`the settings page fits a ${width}px phone`, over <= 1, `${over}px overflow`);
    }
  } finally {
    await browser.close();
  }

  /* ================================================================== */
  await db.query(`delete from clinics where id = any($1::uuid[])`, [[filer.id, bystander.id]]);
  await db.query(`delete from users where email in ($1, $2)`, [filer.userEmail, bystander.userEmail]);
  await db.end();
  server.close();

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
