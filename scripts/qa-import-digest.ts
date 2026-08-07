/**
 * Importing a clinic's old records, and sending a daily digest once.
 *
 * The import half is tested through the parser and the same reading rules the
 * commit uses, because the failures that matter are silent ones: a windows-1256
 * file read as UTF-8 imports six hundred patients whose names are mojibake, and
 * nothing about that looks like an error.
 *
 * The digest half is a regression test with a date on it. Every daily digest
 * fires inside a three-minute window and the scheduler ticks every minute, so
 * without a claim an owner gets the same end-of-day summary three times.
 */
import { Client } from "pg";
import {
  decodeUpload,
  parseDelimited,
  guessMapping,
  readDate,
  readGender,
} from "../src/lib/import/parse";

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

function testParser() {
  console.log("\n── reading whatever arrives ──");

  // Excel on an Arabic Windows machine. The single most likely file to land.
  const cp1256 = Buffer.from([0xe3, 0xcd, 0xe3, 0xcf]); // محمد
  check("a windows-1256 file is not read as UTF-8 rubbish", decodeUpload(cp1256) === "محمد", decodeUpload(cp1256));
  check(
    "a UTF-8 file with a BOM keeps its first column name",
    decodeUpload(Buffer.from("﻿الاسم,هاتف", "utf8")).startsWith("الاسم")
  );

  const csv = 'الاسم,الهاتف,تاريخ الميلاد\n"الخطيب, محمد",0790744070,03/04/1990\nسارة,,\n';
  const p = parseDelimited(csv);
  check("headers are read", p.headers.length === 3, p.headers.join("|"));
  check("a comma inside quotes does not split the name", p.rows[0][0] === "الخطيب, محمد", p.rows[0][0]);
  check("blank trailing lines are not records", p.rows.length === 2, String(p.rows.length));

  const tsv = "Name\tPhone\nOmar\t0791234567";
  check("pasted tab-separated rows work too", parseDelimited(tsv).headers[1] === "Phone");

  const semi = parseDelimited("name;phone\nA;1");
  check("and semicolons, which Excel also writes", semi.headers.length === 2);

  const m = guessMapping(["الاسم", "الهاتف", "تاريخ الميلاد", "Notes", "whatever"]);
  check("Arabic headers are recognised", m[0] === "full_name" && m[1] === "phone", m.join(","));
  check("English headers too", m[3] === "notes");
  check("and an unknown column defaults to being skipped", m[4] === "ignore", m[4]);
  const dup = guessMapping(["Phone", "Phone"]);
  check(
    "two columns never both claim the same field",
    dup.filter((f) => f === "phone").length === 1,
    dup.join(",")
  );

  check("an ISO date is taken as written", readDate("1990-04-03") === "1990-04-03");
  check("a day over twelve proves day-first", readDate("25/12/1990") === "1990-12-25", String(readDate("25/12/1990")));
  check("an ambiguous date is read day-first, as Jordan writes it", readDate("03/04/1990") === "1990-04-03");
  check("nonsense is refused rather than guessed", readDate("hello") === null);
  check("Arabic gender is understood", readGender("ذكر") === "male" && readGender("أنثى") === "female");
  check("and so is English", readGender("F") === "female");
  check("anything else stays unset", readGender("n/a") === null);
}

async function testDigest(db: Client) {
  console.log("\n── the daily summary, once ──");
  const slug = `qadig${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, timezone) values ('QA Digest',$1,'Asia/Amman') returning id`,
      [slug]
    )
  ).rows[0];

  /*
    Exactly what the worker does three times inside its window. The claim, not
    the caller, is what has to make the second and third attempts do nothing.
  */
  const claim = async () => {
    const r = await db.query(
      `insert into jobs (clinic_id, kind, payload, status, dedupe_key)
       values ($1, 'digest:day_end', '{}'::jsonb, 'done', $2)
       on conflict (dedupe_key) do nothing returning id`,
      [clinic.id, `digest:day_end:${clinic.id}:2026-08-07`]
    );
    return (r.rowCount ?? 0) > 0;
  };

  const first = await claim();
  const second = await claim();
  const third = await claim();
  check("the first tick in the window sends", first);
  check("the second does not", !second);
  check("nor the third", !third);

  const tomorrow = await db.query(
    `insert into jobs (clinic_id, kind, payload, status, dedupe_key)
     values ($1, 'digest:day_end', '{}'::jsonb, 'done', $2)
     on conflict (dedupe_key) do nothing returning id`,
    [clinic.id, `digest:day_end:${clinic.id}:2026-08-08`]
  );
  check("but tomorrow's summary still sends", (tomorrow.rowCount ?? 0) > 0);

  const otherClinic = (
    await db.query(`insert into clinics (name, slug) values ('QA Digest 2',$1) returning id`, [
      `${slug}b`,
    ])
  ).rows[0];
  const other = await db.query(
    `insert into jobs (clinic_id, kind, payload, status, dedupe_key)
     values ($1, 'digest:day_end', '{}'::jsonb, 'done', $2)
     on conflict (dedupe_key) do nothing returning id`,
    [otherClinic.id, `digest:day_end:${otherClinic.id}:2026-08-07`]
  );
  check("and one clinic's claim does not silence another's", (other.rowCount ?? 0) > 0);

  await db.query(`delete from clinics where id = any($1)`, [[clinic.id, otherClinic.id]]);
}

async function main() {
  testParser();
  const db = new Client({ connectionString: PG });
  await db.connect();
  await testDigest(db);
  await db.end();

  console.log(`\n  import & digest: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
