/**
 * Paging the patient list, proved rather than assumed.
 *
 * The list used to stop at a hundred rows with nothing to press, so a clinic
 * with years of files could not reach anybody it could not already name. The
 * properties that matter now are the ones a pager gets wrong silently:
 *
 *   - every record is reachable, exactly once — no duplicate across a page
 *     boundary and, far worse because nobody notices, no record skipped;
 *   - a row inserted while somebody is paging does not shift the pages under
 *     them, which is the failure `offset` has and a keyset cursor does not;
 *   - the ordering is stable, so the same walk twice gives the same answer even
 *     though the touch trigger is rewriting `updated_at` throughout;
 *   - the index actually gets used, because the whole point of paging a large
 *     table is not sorting it on every request.
 */
try {
  process.loadEnvFile?.();
} catch {}

import { Client } from "pg";
import { patientFilterSql, patientListRowsSql, PATIENT_PAGE_SIZE } from "../src/lib/patients";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SLUG = "qa-paging-clinic";
/* Two and a bit pages, so a boundary is crossed twice and the last page is short. */
const COUNT = PATIENT_PAGE_SIZE * 2 + 37;

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ok  ${n}`);
  } else {
    fails.push(`${n} — ${d}`);
    console.log(`  FAIL ${n} ${d}`);
  }
};

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  await db.query(`delete from clinics where slug = $1`, [SLUG]);
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone, default_locale, subscription_status)
       values ('QA Paging', 'ترقيم', $1, 'Asia/Amman', 'ar', 'active') returning id`,
      [SLUG]
    )
  ).rows[0].id;

  /*
    Deliberately many patients sharing one created_at. That is the case a cursor
    on the timestamp alone gets wrong — it either re-reads or skips whoever
    shares the boundary millisecond — and it is realistic, because an import
    writes a whole file in one statement.
  */
  await db.query(
    `insert into patients (clinic_id, full_name, phone_e164, status, created_at)
     select $1, 'مريض ' || g, '+96278' || lpad(g::text, 7, '0'), 'active',
            now() - ((g / 50)::int) * interval '1 day'
       from generate_series(1, $2) g`,
    [clinicId, COUNT]
  );

  const { where, values } = patientFilterSql(clinicId, {});

  /** Walks every page with the cursor, exactly as the route does. */
  async function walk(): Promise<{ id: string; created_at: string }[]> {
    const seen: { id: string; created_at: string }[] = [];
    let cursor: { ts: string; id: string } | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const vals = [...values];
      const sql = patientListRowsSql(where, cursor ? vals.length + 1 : null);
      if (cursor) vals.push(cursor.ts, cursor.id);
      const rows = (await db.query(sql, vals)).rows;
      seen.push(...rows.map((r) => ({ id: r.id, created_at: r.created_at })));
      if (rows.length < PATIENT_PAGE_SIZE) return seen;
      const last = rows[rows.length - 1];
      cursor = { ts: last.created_at, id: last.id };
    }
    throw new Error("walk did not terminate");
  }

  console.log("\n[every record, exactly once]");
  const all = await walk();
  ok("reached every patient", all.length === COUNT, `got ${all.length} of ${COUNT}`);
  const ids = new Set(all.map((r) => r.id));
  ok("no record appeared twice", ids.size === all.length, `${all.length - ids.size} duplicates`);
  const inDb = Number(
    (await db.query(`select count(*)::int as n from patients where clinic_id = $1`, [clinicId]))
      .rows[0].n
  );
  ok("no record was skipped", ids.size === inDb, `${inDb - ids.size} missing`);

  console.log("\n[a shared timestamp does not break the boundary]");
  const perDay = new Map<string, number>();
  for (const r of all) {
    const k = String(r.created_at);
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  ok("the fixture really does share timestamps", [...perDay.values()].some((n) => n > 1));

  console.log("\n[the order is stable under a touch]");
  /*
    The exact thing that made the old ordering unpageable: `updated_at` is
    rewritten by the trigger on any write, so ordering by it meant a row could
    jump to the front of the list between two page requests.
  */
  await db.query(
    `update patients set full_name = full_name || '' where clinic_id = $1
      and id in (select id from patients where clinic_id = $1 order by random() limit 20)`,
    [clinicId]
  );
  const again = await walk();
  ok(
    "the same walk gives the same order after 20 rows are touched",
    again.map((r) => r.id).join(",") === all.map((r) => r.id).join(",")
  );

  console.log("\n[an insert does not shift the pages below it]");
  const firstPageVals = [...values];
  const firstPage = (await db.query(patientListRowsSql(where, null), firstPageVals)).rows;
  const cursorRow = firstPage[firstPage.length - 1];
  // Somebody adds a patient while the reader is on page one. With `offset` this
  // is what pushes one record off page two and out of sight entirely.
  await db.query(
    `insert into patients (clinic_id, full_name, phone_e164, status)
     values ($1, 'وافد جديد', '+962789999999', 'active')`,
    [clinicId]
  );
  const afterVals = [...values, cursorRow.created_at, cursorRow.id];
  const page2 = (
    await db.query(patientListRowsSql(where, values.length + 1), afterVals)
  ).rows;
  const page1Ids = new Set(firstPage.map((r) => r.id));
  ok(
    "page two still starts where page one ended",
    page2.every((r) => !page1Ids.has(r.id)),
    "a row from page one reappeared"
  );

  console.log("\n[the list is indexed, not sorted]");
  const plan = (
    await db.query(`explain (analyze, buffers) ${patientListRowsSql(where, null)}`, [...values])
  ).rows
    .map((r) => r["QUERY PLAN"])
    .join("\n");
  ok("uses patients_list_idx", /patients_list_idx/.test(plan), plan.split("\n")[0]);
  ok(
    "does not sort the clinic's whole table",
    !/\bSort Method: external/.test(plan),
    "spilled a sort to disk"
  );

  await db.query(`delete from clinics where slug = $1`, [SLUG]);
  await db.end();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
