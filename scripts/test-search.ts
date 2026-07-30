/**
 * Patient search must survive the way Arabic is actually typed.
 *
 * Staff search by ear, not by orthography: hamza gets dropped, taa marbuta and
 * haa are swapped, alif maqsura and yaa are mixed, and names captured from
 * WhatsApp profiles arrive with diacritics nobody retypes. A literal comparison
 * fails all of those, which on the patients screen means the file "doesn't
 * exist" and staff create a duplicate.
 *
 *   npx tsx scripts/test-search.ts
 */
import { Client } from "pg";

try {
  process.loadEnvFile?.();
} catch {}

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

/** [stored spelling, what someone types when looking for it] */
const SHOULD_MATCH: [string, string][] = [
  ["أحمد قاسم", "احمد"],
  ["احمد قاسم", "أحمد"],
  ["إبراهيم", "ابراهيم"],
  ["آمنة", "امنه"],
  ["سارة الشريف", "ساره"],
  ["ساره الشريف", "سارة"],
  ["يحيى", "يحيي"],
  ["مُحَمَّد", "محمد"],
  ["عبد الرؤوف", "عبد الرووف"],
  ["رائد", "رايد"],
  ["فاطمة الزهراء", "فاطمه"],
  ["Rima Haddad", "rima"],
  ["rima haddad", "RIMA"],
];

/** Different names must stay different — normalising must not merge people. */
const SHOULD_NOT_MATCH: [string, string][] = [
  ["سامي", "رامي"],
  ["حسن", "حسين"],
  ["منى", "منال"],
  ["Rima", "Rana"],
];

async function main() {
  const c = new Client({ connectionString: PG });
  await c.connect();

  for (const [stored, typed] of SHOULD_MATCH) {
    const r = await c.query(`select ar_normalize($1) like ar_normalize($2) as hit`, [
      stored,
      `%${typed}%`,
    ]);
    check(`"${typed}" should find "${stored}"`, r.rows[0].hit === true);
  }

  for (const [stored, typed] of SHOULD_NOT_MATCH) {
    const r = await c.query(`select ar_normalize($1) like ar_normalize($2) as hit`, [
      stored,
      `%${typed}%`,
    ]);
    check(`"${typed}" must not find "${stored}"`, r.rows[0].hit === false);
  }

  // The normaliser has to be immutable for the index on it to be usable.
  const vol = await c.query(
    `select provolatile from pg_proc where proname = 'ar_normalize'`
  );
  check("ar_normalize is immutable (required by its index)", vol.rows[0]?.provolatile === "i");

  // And the index must actually exist, or search degrades to a full scan.
  const idx = await c.query(
    `select 1 from pg_indexes where tablename = 'patients' and indexname = 'patients_name_norm_trgm_idx'`
  );
  check("trigram index on ar_normalize(full_name) exists", idx.rowCount === 1);

  await c.end();
  console.log(`\nsearch tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
