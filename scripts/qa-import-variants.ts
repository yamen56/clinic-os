/**
 * QA: the shapes a real patient list actually arrives in.
 *
 * Nobody sends the file the importer was designed for. What turns up is an
 * `.xlsx` straight out of Excel, or a sheet with the clinic's name sitting alone
 * above the headers, or a list whose names are split across two columns, or a
 * CSV saved on an Arabic Windows machine in windows-1256. Each of those used to
 * end the same way — a screen of nonsense, or every column mapped to "skip" —
 * and each looks to the person holding the file like the product cannot read it.
 *
 * So this builds those files for real, with the same library Excel-compatible
 * writers use, and pushes them through the importer to the point where a patient
 * exists with the right name and a reachable number. Anything less than a real
 * row in `patients` is not an import.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import ExcelJS from "exceljs";
import bcrypt from "bcryptjs";
import { parseDelimited, guessMapping, readDate, readGender } from "../src/lib/import/parse";
import { xlsxToDelimited } from "../src/lib/import/sheet";
import { resolveCapabilities } from "../src/lib/permissions";
import { normalizePhone } from "../src/lib/phone";

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

/** Builds a real xlsx in memory, the way Excel would write one. */
async function makeXlsx(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  /* ================================================================== */
  console.log("\n[a real Excel file]");

  const xlsx = await makeXlsx([
    ["Full Name", "Mobile", "Date of Birth", "Gender"],
    ["أحمد عبد الرحمن", "0790744070", new Date(Date.UTC(1990, 3, 17)), "male"],
    // Excel stores a phone typed without quotes as a number, losing the zero.
    ["Sara Nasser", 791234567, "1985-06-02", "F"],
  ]);
  check("the bytes are a zip, as every xlsx is", xlsx[0] === 0x50 && xlsx[1] === 0x4b);

  const text = await xlsxToDelimited(xlsx);
  const sheet = parseDelimited(text);
  check("its headers come through", sheet.headers.join("|") === "Full Name|Mobile|Date of Birth|Gender", sheet.headers.join("|"));
  check("and both rows", sheet.rows.length === 2, String(sheet.rows.length));
  check("Arabic survives the spreadsheet", sheet.rows[0][0] === "أحمد عبد الرحمن", sheet.rows[0][0]);
  /*
    A date cell is a serial number, not text. Formatted from its UTC parts, or a
    birthday moves a day for every clinic west of Greenwich.
  */
  check("a date cell reads as the date on the sheet", sheet.rows[0][2] === "1990-04-17", sheet.rows[0][2]);

  const mapping = guessMapping(sheet.headers);
  check(
    "the columns map themselves",
    mapping.join(",") === "full_name,phone,birth_date,gender",
    mapping.join(",")
  );
  check(
    "a phone Excel turned into a number is still reachable",
    normalizePhone(String(sheet.rows[1][1]), "JO") === "+962791234567",
    String(normalizePhone(String(sheet.rows[1][1]), "JO"))
  );
  check("gender written as F is read", readGender(String(sheet.rows[1][3])) === "female");

  /* ================================================================== */
  console.log("\n[a sheet with a title above the table]");

  const titled = await makeXlsx([
    ["Al Rima Dental — patient list 2024"],
    [],
    ["Name", "Phone", "Notes"],
    ["Layla Haddad", "0777123456", "prefers mornings"],
  ]);
  const titledSheet = parseDelimited(await xlsxToDelimited(titled));
  check(
    "the real header row is found, not the title",
    titledSheet.headers.join("|").startsWith("Name|Phone"),
    titledSheet.headers.join("|")
  );
  check("and the patient below it is a row, not a header", titledSheet.rows.length === 1, String(titledSheet.rows.length));
  check(
    "so the columns still map",
    guessMapping(titledSheet.headers).join(",") === "full_name,phone,notes",
    guessMapping(titledSheet.headers).join(",")
  );

  /* ================================================================== */
  console.log("\n[a name split across two columns]");

  const split = parseDelimited(
    "First Name,Last Name,Mobile\nOmar,Khalidi,0788111222\nنور,الشمري,0799333444"
  );
  const splitMap = guessMapping(split.headers);
  check(
    "first and last are recognised as their own columns",
    splitMap.join(",") === "first_name,last_name,phone",
    splitMap.join(",")
  );
  /* The join is what the importer does when it reads the row. */
  const joined = (cells: string[]) =>
    [cells[splitMap.indexOf("first_name")], cells[splitMap.indexOf("last_name")]]
      .filter(Boolean)
      .join(" ")
      .trim();
  check("and are joined into one name", joined(split.rows[0]) === "Omar Khalidi", joined(split.rows[0]));
  check("in Arabic too", joined(split.rows[1]) === "نور الشمري", joined(split.rows[1]));

  /*
    A sheet carrying both must not append the surname to a name that already
    ends in it.
  */
  const both = guessMapping(["Full Name", "First Name", "Last Name", "Phone"]);
  check(
    "a sheet with both kinds prefers the full name and ignores the parts",
    both.join(",") === "full_name,ignore,ignore,phone",
    both.join(",")
  );

  /* ================================================================== */
  console.log("\n[the other ways a file arrives]");

  // Headed with the definite article on every word, which is how most Arabic
  // sheets are actually written.
  const semi = parseDelimited("الاسم;الجوال;الملاحظات\nمحمد علي;0791112223;سكري");
  check(
    "a semicolon file, headed in Arabic, maps itself",
    guessMapping(semi.headers).join(",") === "full_name,phone,notes",
    guessMapping(semi.headers).join(",")
  );
  const tabbed = parseDelimited("Name\tPhone\nZaid\t0790000111");
  check("so does a tab-separated paste out of Excel", guessMapping(tabbed.headers)[0] === "full_name");
  const quoted = parseDelimited('Name,Phone\n"Haddad, Layla",0777123456');
  check("a quoted name containing a comma stays one cell", quoted.rows[0][0] === "Haddad, Layla", quoted.rows[0][0]);

  /* Dates, in the orders a clinic actually writes them. */
  check("a day-first date is read day-first", readDate("17/04/1990") === "1990-04-17", String(readDate("17/04/1990")));
  check("an ISO date is taken as written", readDate("1990-04-17") === "1990-04-17", String(readDate("1990-04-17")));
  check("a two-digit year lands in the right century", readDate("02/06/85") === "1985-06-02", String(readDate("02/06/85")));

  /* ================================================================== */
  console.log("\n[who may import, and who may take the list out]");

  /*
    Import was open to anyone with Patients before it became a capability of its
    own, so an existing member's silence has to keep meaning yes. Export was
    owner-only, so the same silence has to keep meaning no — reading it as a
    grant would hand the whole database to every member on deploy.
  */
  const oldMap = { level: "custom" as const, caps: { patients: true } };
  const resolved = resolveCapabilities(oldMap, { isOwner: false, role: "receptionist" });
  check("a member who could import still can", resolved["patients.import"] === true);
  check("and one who could not export still cannot", resolved["patients.export"] === false);

  const owner = resolveCapabilities(null, { isOwner: true, role: "receptionist" });
  check("the owner has both, as they always did", owner["patients.import"] && owner["patients.export"]);

  const granted = resolveCapabilities(
    { level: "custom", caps: { patients: true, "patients.export": true } },
    { isOwner: false, role: "receptionist" }
  );
  check("and an owner can now grant the export to somebody else", granted["patients.export"] === true);

  const noSection = resolveCapabilities(
    { level: "custom", caps: { patients: false, "patients.export": true, "patients.import": true } },
    { isOwner: false, role: "receptionist" }
  );
  check(
    "neither outlives the Patients section itself",
    !noSection["patients.export"] && !noSection["patients.import"]
  );

  /* ================================================================== */
  console.log("\n[end to end: the rows become patients]");

  const stamp = Date.now().toString(36);
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, default_locale, timezone) values ('QA Import',$1,'ar','Asia/Amman') returning id`,
      [`qaimp${stamp}`]
    )
  ).rows[0];
  await db.query(`select seed_note_categories($1)`, [clinic.id]);
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1,$2,'QA') returning id`,
      [`imp-${stamp}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, user.id]
  );

  /*
    Written straight through the same reads the commit uses, because what is
    under test here is that the parsed values are storable — a name that fits,
    a phone in E.164, a date Postgres accepts.
  */
  const batch = (
    await db.query(
      `insert into import_batches (clinic_id, filename, mapping, row_count, created_by)
       values ($1,'variants.xlsx',$2,2,$3) returning id`,
      [clinic.id, JSON.stringify(mapping), user.id]
    )
  ).rows[0];
  for (const cells of sheet.rows) {
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, birth_date, gender, source, status, import_batch_id)
       values ($1,$2,$3,$4::date,$5,'import','active',$6)`,
      [
        clinic.id,
        cells[mapping.indexOf("full_name")],
        normalizePhone(String(cells[mapping.indexOf("phone")]), "JO"),
        readDate(String(cells[mapping.indexOf("birth_date")])),
        readGender(String(cells[mapping.indexOf("gender")])),
        batch.id,
      ]
    );
  }
  const stored = (
    await db.query(
      `select full_name, phone_e164, birth_date, gender from patients
        where clinic_id = $1 order by full_name`,
      [clinic.id]
    )
  ).rows;
  check("both rows became patients", stored.length === 2, String(stored.length));
  const arabic = stored.find((p) => p.full_name === "أحمد عبد الرحمن");
  check("the Arabic name is stored intact", Boolean(arabic), stored.map((p) => p.full_name).join(" / "));
  check("with a reachable number", arabic?.phone_e164 === "+962790744070", arabic?.phone_e164 ?? "");
  /*
    node-pg hands a `date` column back as a JS Date, whose `String()` is
    "Tue Apr 17 1990 …" — so this reads the calendar parts rather than the text,
    the same trap the spreadsheet export hit.
  */
  const asDate = (v: unknown) => {
    const d = new Date(v as string);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  check(
    "and the birth date off the spreadsheet",
    Boolean(arabic) && asDate(arabic!.birth_date) === "1990-04-17",
    asDate(arabic?.birth_date)
  );
  check(
    "the number Excel stripped a zero from is reachable too",
    stored.some((p) => p.phone_e164 === "+962791234567"),
    stored.map((p) => p.phone_e164).join(" / ")
  );

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [user.id]);
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
