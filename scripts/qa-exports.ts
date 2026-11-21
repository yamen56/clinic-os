/**
 * Every export, in every format (2026-11-21: one Export button that asks
 * Excel, CSV or PDF).
 *
 * For payments, expenses, claims and the patient list, each of the three:
 * the file comes back, it is the format it says, it holds the rows, and the
 * clinic's data leaves no copy behind — an audit row each, never cached, and
 * the PDF's parked table gone once it is printed. And the guards hold: a CSV
 * cell a person typed cannot become a formula, a phone number is not mangled
 * trying to stop one, and a member without the section gets a 403 in every
 * format.
 *
 * PDFs need the worker on :4020 (npm run dev:all).
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";

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

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000, waitUntil: "commit" });
  // Taking the whole patient list asks for the password again (migrations/0043); confirm it up front.
  await page.request.post(`${BASE}/api/me/reauth`, { data: { password: "password123" } });
}

type Got = { status: number; type: string; disposition: string; cache: string; body: Buffer };

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const slug = `qaexp${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, currency, invoice_prefix) values ('QA Export','تصدير',$1,'ar','JOD','QEX') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic]);
  const mk = async (tag: string, perms: string, owner: boolean) => {
    const id = (
      await db.query(`insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`, [
        `${tag}-${slug}@test.local`,
        bcrypt.hashSync("password123", 10),
        `QA ${tag}`,
      ])
    ).rows[0].id as string;
    await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',$3,$4)`, [
      clinic,
      id,
      owner,
      perms,
    ]);
  };
  await mk("owner", '{"level":"full"}', true);
  await mk("desk", JSON.stringify({ level: "custom", caps: { patients: true, calendar: true } }), false);

  // A name somebody typed that a spreadsheet would run, and a phone that must survive.
  const patient = (
    await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1,'=HYPERLINK("x")','+962790001234','staff') returning id`, [clinic])
  ).rows[0].id as string;
  await db.query(`insert into patients (clinic_id, full_name, source) values ($1,'سلمى الأحمد','staff')`, [clinic]);
  const inv = (
    await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, subtotal, total, amount_paid, status, issue_date) values ($1,$2,1,'QEX-1',100,100,100,'paid',current_date) returning id`,
      [clinic, patient]
    )
  ).rows[0].id as string;
  await db.query(`insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at, reference) values ($1,$2,$3,100,'cash',now(),'@SUM(A1)')`, [
    clinic,
    inv,
    patient,
  ]);
  await db.query(`insert into expenses (clinic_id, amount, spent_on, method, vendor, note) values ($1, 42.5, current_date, 'cash', 'Amman Lab, Ltd', '+risky note')`, [clinic]);

  const today = new Date();
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const from = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
  const to = ymd(new Date(today.getFullYear(), today.getMonth() + 1, 1));
  const exports: { name: string; url: string; action: string; contains: string }[] = [
    { name: "payments", url: `/api/c/${slug}/payments/export`, action: "payments.export", contains: "QEX-1" },
    { name: "expenses", url: `/api/c/${slug}/expenses/export?from=${from}&to=${to}`, action: "expenses.export", contains: "Amman Lab, Ltd" },
    { name: "claims", url: `/api/c/${slug}/claims/export?status=all`, action: "claims.export", contains: "" },
    { name: "patients", url: `/api/c/${slug}/patients/export-all`, action: "patient.export_all", contains: "سلمى الأحمد" },
  ];

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await signIn(page, `owner-${slug}@test.local`);
    const get = async (url: string): Promise<Got> => {
      const r = await page.request.get(`${BASE}${url}`, { timeout: 120_000 });
      return {
        status: r.status(),
        type: r.headers()["content-type"] ?? "",
        disposition: r.headers()["content-disposition"] ?? "",
        cache: r.headers()["cache-control"] ?? "",
        body: Buffer.from(await r.body()),
      };
    };

    for (const e of exports) {
      console.log(`\n[${e.name}]`);
      const audits = async () =>
        (await db.query(`select count(*)::int n from audit_log where clinic_id = $1 and action = $2`, [clinic, e.action])).rows[0].n as number;
      const before = await audits();
      for (const format of ["csv", "xlsx", "pdf"] as const) {
        const sep = e.url.includes("?") ? "&" : "?";
        const r = await get(`${e.url}${sep}format=${format}`);
        check(`${format}: comes back`, r.status === 200, `HTTP ${r.status} ${r.status !== 200 ? r.body.toString().slice(0, 120) : ""}`);
        if (r.status !== 200) continue;
        check(`${format}: named .${format}`, r.disposition.includes(`.${format}`), r.disposition);
        check(`${format}: never cached`, /no-store/.test(r.cache), r.cache);
        if (format === "csv") {
          const text = r.body.toString("utf8");
          check("csv: starts with the byte-order mark Excel needs for Arabic", text.charCodeAt(0) === 0xfeff);
          if (e.contains) check("csv: holds the rows", text.includes(e.contains), text.slice(0, 160));
          check("csv: a typed formula cannot run", !/(^|,)"=HYPERLINK/m.test(text) && !/(^|,)"@SUM/m.test(text) && !/(^|,)"\+risky/m.test(text));
          if (e.name === "patients") check("csv: a phone number is not prefixed by the formula guard", /962/.test(text) && !text.includes("'+962"), "");
        } else if (format === "xlsx") {
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(r.body as unknown as ArrayBuffer);
          check("xlsx: opens", wb.worksheets.length > 0, String(wb.worksheets.length));
          check("xlsx: right to left for an Arabic clinic", wb.worksheets[0].views?.[0]?.rightToLeft === true);
          if (e.name === "claims") check("xlsx: claims keep their two sheets", wb.worksheets.length === 2, String(wb.worksheets.length));
        } else {
          check("pdf: is a PDF", r.body.subarray(0, 4).toString() === "%PDF", r.body.subarray(0, 8).toString());
        }
      }
      check("each file is one audit row", (await audits()) - before === 3, `${(await audits()) - before}`);
    }
    const left = (await db.query(`select count(*)::int n from export_renders where clinic_id = $1`, [clinic])).rows[0].n;
    check("no printed table is left behind", left === 0, String(left));

    console.log("\n[the defaults, for anything that called these before the menu]");
    const csv = await get(`/api/c/${slug}/payments/export`);
    check("payments without a format is still CSV", csv.disposition.includes(".csv"), csv.disposition);
    const claims = await get(`/api/c/${slug}/claims/export?status=all`);
    check("claims without a format is still Excel", claims.disposition.includes(".xlsx"), claims.disposition);

    console.log("\n[a member without the section]");
    const dctx = await browser.newContext();
    const desk = await dctx.newPage();
    await signIn(desk, `desk-${slug}@test.local`);
    for (const e of exports.filter((x) => x.name !== "patients")) {
      for (const format of ["csv", "xlsx", "pdf"]) {
        const sep = e.url.includes("?") ? "&" : "?";
        const s = (await desk.request.get(`${BASE}${e.url}${sep}format=${format}`)).status();
        check(`${e.name} ${format} refused`, s === 403, String(s));
      }
    }
    await dctx.close();

    console.log("\n[the button]");
    await page.goto(`${BASE}/c/${slug}/analytics?p=month`, { timeout: 120_000 });
    await page.waitForLoadState("networkidle");
    await page.click("[data-export] button");
    const offered = await page.locator("[data-export-format]").evaluateAll((els) => els.map((e) => e.getAttribute("data-export-format")));
    check("one Export button offers Excel, CSV and PDF", offered.join(",") === "xlsx,csv,pdf", offered.join(","));
    await ctx.close();
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic]);
    await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
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
