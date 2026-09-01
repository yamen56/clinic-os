/**
 * QA: the patient list as a spreadsheet.
 *
 * The assertion that matters is not "a file came back" — a corrupt zip and a
 * valid workbook are the same 200 to a browser, and the failure only shows up
 * on somebody's desk when Excel refuses to open it. So every check below reads
 * the bytes back through a real xlsx parser and asks what is actually in the
 * cells.
 *
 * Two things beyond that are worth protecting:
 *   - Arabic. It is the product's default language, and the reason a real
 *     workbook was worth building instead of a CSV, which Excel on Windows
 *     mangles without a byte-order mark. If a name does not survive the round
 *     trip, this feature has failed at the thing it exists for.
 *   - The gate. This is the entire patient database in one file; it is owner-only
 *     for exactly the same reason the PDF is, and the two must not drift.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import ExcelJS from "exceljs";
import bcrypt from "bcryptjs";
import { chromium } from "playwright";
import { MAX_SHEET_RECORDS } from "../src/lib/patient-sheet";
import { ar } from "../src/lib/i18n/ar";

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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const stamp = Date.now().toString(36);
  const slug = `qaxls${stamp}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix)
       values ('QA Sheet','جدول',$1,'ar','Asia/Amman','JOD','QAX') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`select seed_note_categories($1)`, [clinic.id]);

  const mkUser = async (email: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale)
         values ($1,$2,$3,'ar') returning id`,
        [email, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;

  const ownerId = await mkUser(`owner-${slug}@test.local`, "QA Owner");
  const deskId = await mkUser(`desk-${slug}@test.local`, "QA Desk");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, ownerId]
  );
  /*
    A member with the Patients section and nothing said about exporting it.

    Not `{"level":"full"}`, which is what this used to be: full access is
    documented as everything including capabilities that do not exist yet, so an
    owner who chose it has chosen the export too. The case worth protecting is
    the limited member — the stored map is silent about `patients.export`, and
    silence has to keep meaning no, because that capability replaced an
    owner-only rule.
  */
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1,$2,'receptionist',$3)`,
    [clinic.id, deskId, JSON.stringify({ level: "custom", caps: { patients: true } })]
  );

  /* An Arabic name with the letters that normalisation touches, and a Latin one. */
  const ARABIC = "أحمد عبد الرحمن";
  const alice = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, birth_date, gender, tags, source, status)
       values ($1,$2,$3,'1990-04-17','male','{"سكري","vip"}','staff','active') returning id`,
      [clinic.id, ARABIC, `+96279${Math.floor(1000000 + Math.random() * 8999999)}`]
    )
  ).rows[0].id as string;
  const bob = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source, status, automation_opt_out)
       values ($1,'Zed Barlow',$2,'booking_link','active',true) returning id`,
      [clinic.id, `+96279${Math.floor(1000000 + Math.random() * 8999999)}`]
    )
  ).rows[0].id as string;

  const NOTE = "المريض يعاني من حساسية البنسلين، ويفضّل المواعيد الصباحية.";
  await db.query(
    `insert into patient_notes (clinic_id, patient_id, author_id, body) values ($1,$2,$3,$4)`,
    [clinic.id, alice, ownerId, NOTE]
  );
  await db.query(
    `insert into invoices (clinic_id, patient_id, seq, number, status, currency,
                           subtotal, discount_amount, tax_rate, tax_amount, total, amount_paid, issue_date)
     values ($1,$2,1,'QAX-2026-0001','partially_paid','JOD',300,0,0,0,300,120,current_date)`,
    [clinic.id, alice]
  );
  console.log(`\n✓ fixtures: ${slug}, two patients, one Arabic note, one part-paid invoice`);

  /* ================================================================== */
  console.log("\n[the file that comes back]");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  let book: ExcelJS.Workbook | null = null;
  try {
    const signIn = async (email: string) => {
      await ctx.clearCookies();
      await page.goto(`${BASE}/login`);
      await page.waitForLoadState("networkidle");
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', "password123");
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
    };

    await signIn(`owner-${slug}@test.local`);

    const url = `${BASE}/api/c/${slug}/patients/export-all?format=xlsx`;
    const got = await page.evaluate(
      `(async () => {
         const r = await fetch(${JSON.stringify(url)});
         if (!r.ok) return { status: r.status };
         const b = new Uint8Array(await r.arrayBuffer());
         return {
           status: r.status,
           type: r.headers.get("content-type"),
           disposition: r.headers.get("content-disposition"),
           cache: r.headers.get("cache-control"),
           bytes: Array.from(b),
         };
       })()`
    ) as {
      status: number;
      type?: string;
      disposition?: string;
      cache?: string;
      bytes?: number[];
    };

    check("the owner gets a file", got.status === 200, String(got.status));
    /*
      Opaque bytes, and deliberately so. `fileResponseHeaders` renders only types
      that cannot carry script and downloads everything else as
      application/octet-stream with nosniff — a rule worth more than a tidy
      Content-Type, and one this route must not become the exception to. What
      makes the file open in Excel is the extension, not the header.
    */
    check(
      "handed over as opaque bytes rather than a type the browser might render",
      (got.type ?? "") === "application/octet-stream",
      got.type ?? ""
    );
    check(
      "as an attachment named .xlsx, which is what opens it in Excel",
      (got.disposition ?? "").startsWith("attachment") && (got.disposition ?? "").includes(".xlsx"),
      got.disposition ?? ""
    );
    check(
      "and never cached — the browser cache outlives the session that fetched it",
      (got.cache ?? "").includes("no-store"),
      got.cache ?? ""
    );

    const buf = Buffer.from(got.bytes ?? []);
    /* A real zip, before anything tries to read it as one. */
    check(
      "the bytes are a zip archive, which is what an xlsx is",
      buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b,
      `${buf.length} bytes, magic ${buf.slice(0, 2).toString("hex")}`
    );

    /* ---- and now the part that a 200 cannot tell you: does it parse? ---- */
    book = new ExcelJS.Workbook();
    await book.xlsx.load(buf as unknown as ArrayBuffer);
    check("a spreadsheet reader can open it", book.worksheets.length > 0);

    const names = book.worksheets.map((w) => w.name);
    check(
      "with a sheet per kind of record",
      [
        ar.patientSheet.sheetPatients,
        ar.patientSheet.sheetNotes,
        ar.patientSheet.sheetAppointments,
        ar.patientSheet.sheetInvoices,
      ].every((n) => names.includes(n)),
      names.join(", ")
    );

    const sheet = book.getWorksheet(ar.patientSheet.sheetPatients)!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    check(
      "the patients sheet is headed in the clinic's own language",
      header[0] === ar.patientSheet.name && header.includes(ar.patientSheet.outstanding),
      header.slice(0, 6).join(" | ")
    );

    /** Every row as a plain array, so lookups read like the sheet does. */
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? "" : String(v))));
    });
    check("one row per patient", rows.length === 2, String(rows.length));

    const arabicRow = rows.find((r) => r[0] === ARABIC);
    check("the Arabic name survives the round trip intact", Boolean(arabicRow), rows.map((r) => r[0]).join(" / "));

    if (arabicRow) {
      const col = (h: string) => arabicRow[header.indexOf(h)];
      check("the date of birth is the date on the file, unshifted", col(ar.patientSheet.birthDate) === "1990-04-17", col(ar.patientSheet.birthDate));
      check("tags come across as a readable list", col(ar.patientSheet.tags).includes("سكري"), col(ar.patientSheet.tags));
      check("the status is a word, not a database value", col(ar.patientSheet.status) === ar.patients.statusActive, col(ar.patientSheet.status));
      /*
        Money as a number, and as the right one. 300 billed against 120 paid is
        180 owed — the figure reception is asked for, and the reason a column of
        it has to add up rather than be text.
      */
      check("billed, paid and outstanding are numbers that agree", col(ar.patientSheet.billed) === "300" && col(ar.patientSheet.paid) === "120" && col(ar.patientSheet.outstanding) === "180", `${col(ar.patientSheet.billed)}/${col(ar.patientSheet.paid)}/${col(ar.patientSheet.outstanding)}`);
      check("age is worked out from the birth date", Number(col(ar.patientSheet.age)) >= 35, col(ar.patientSheet.age));
      check("the counts say what the patient has", col(ar.patientSheet.notesCount) === "1" && col(ar.patientSheet.invoicesCount) === "1", `${col(ar.patientSheet.notesCount)}/${col(ar.patientSheet.invoicesCount)}`);
    }

    const mutedRow = rows.find((r) => r[0] === "Zed Barlow");
    check(
      "a muted patient is marked as muted",
      mutedRow?.[header.indexOf(ar.patientSheet.mutedFromAutomations)] === ar.patientSheet.yes,
      mutedRow?.[header.indexOf(ar.patientSheet.mutedFromAutomations)] ?? ""
    );

    /* The Arabic note, in a cell, unmangled. */
    const notesSheet = book.getWorksheet(ar.patientSheet.sheetNotes)!;
    const noteRow = (notesSheet.getRow(2).values as unknown[]).slice(1).map((v) => String(v ?? ""));
    check("the note is carried across in full", noteRow.includes(NOTE), noteRow.join(" | ").slice(0, 90));

    /* ================================================================== */
    console.log("\n[who may take it]");

    await signIn(`desk-${slug}@test.local`);
    /*
      `cache: "no-store"` on the request as well as `no-store` on the response.
      The first run of this suite passed the owner's file to this account out of
      the browser cache and reported a 200 — the guard was never reached. Asking
      the question twice is cheap; asking it once and getting the wrong answer
      cost a real bug on the way in.
    */
    const asDesk = await page.evaluate(
      `(async () => {
         const r = await fetch(${JSON.stringify(url)}, { cache: "no-store" });
         return r.status;
       })()`
    );
    check(
      "a member never granted the export cannot take the spreadsheet",
      asDesk === 403,
      String(asDesk)
    );

    const asDeskPdf = await page.evaluate(
      `(async () => {
         const r = await fetch(${JSON.stringify(`${BASE}/api/c/${slug}/patients/export-all`)}, { cache: "no-store" });
         return r.status;
       })()`
    );
    check("and the two formats guard it identically", asDeskPdf === 403, String(asDeskPdf));

    /*
      The other half of the same switch: the section they do have still works, so
      this is a member limited from taking the list out rather than one locked
      out of patients altogether.
    */
    const asDeskList = await page.evaluate(
      `(async () => {
         const r = await fetch(${JSON.stringify(`${BASE}/c/${slug}/patients`)}, { cache: "no-store" });
         return r.status;
       })()`
    );
    check("while the patient list itself still opens for them", asDeskList === 200, String(asDeskList));

    /* ================================================================== */
    console.log("\n[the limits]");
    check(
      "the spreadsheet carries far more than the printed record can",
      MAX_SHEET_RECORDS >= 4000,
      String(MAX_SHEET_RECORDS)
    );

    await signIn(`owner-${slug}@test.local`);
    const empty = await page.evaluate(
      `(async () => {
         const r = await fetch(${JSON.stringify(`${url}&q=zzzznobodyzzz`)}, { cache: "no-store" });
         return r.status;
       })()`
    );
    check("a filter matching nobody is refused, not sent as an empty book", empty === 404, String(empty));
  } finally {
    await browser.close();
  }

  /* ================================================================== */
  const audited = (
    await db.query(
      `select detail from audit_log
        where clinic_id = $1 and action = 'patient.export_all'
        order by created_at desc limit 1`,
      [clinic.id]
    )
  ).rows[0];
  check("taking the database is written down", Boolean(audited), "");
  check(
    "with the format and the number of records in it",
    audited?.detail?.format === "xlsx" && audited?.detail?.count === 2,
    JSON.stringify(audited?.detail ?? {})
  );

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = any($1::uuid[])`, [[ownerId, deskId]]);
  await db.end();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
