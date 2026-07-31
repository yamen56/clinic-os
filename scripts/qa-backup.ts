/**
 * Proves the backup can actually be restored.
 *
 * An untested backup is a belief, not a safeguard, and the day you find out is
 * always the worst possible day. So this takes a real backup of the development
 * database, restores it into an empty one, and compares the two by content —
 * not by row counts, which say nothing about whether jsonb or Arabic survived.
 */
import { Client } from "pg";
import { backupDatabase, restoreDatabase, readBackup, listBackups } from "../src/lib/backup";

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

const PORT = process.env.PG_PORT || 5544;
const SUPER = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const SOURCE = `postgres://postgres:postgres@127.0.0.1:${PORT}/clinicos`;
const TARGET_DB = "clinicos_restoretest";
const TARGET = `postgres://postgres:postgres@127.0.0.1:${PORT}/${TARGET_DB}`;

/** Content checksums — the things a naive backup silently mangles. */
const CHECKS: [string, string][] = [
  ["Arabic patient names", `select md5(coalesce(string_agg(full_name,'|' order by id),'')) h from patients`],
  ["jsonb custom_fields", `select md5(coalesce(string_agg(custom_fields::text,'|' order by id),'')) h from patients`],
  ["text[] extra_phones", `select md5(coalesce(string_agg(extra_phones::text,'|' order by id),'')) h from patients`],
  ["numeric money", `select md5(coalesce(string_agg(total::text,'|' order by id),'')) h from invoices`],
  ["timestamps", `select md5(coalesce(string_agg(starts_at::text,'|' order by id),'')) h from appointments`],
  ["message bodies", `select md5(coalesce(string_agg(body,'|' order by id),'')) h from messages`],
  ["password hashes", `select md5(coalesce(string_agg(coalesce(password_hash,''),'|' order by id),'')) h from users`],
];

async function q(url: string, sql: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  const r = await c.query(sql);
  await c.end();
  return r;
}

async function main() {
  console.log("▶ backup and restore");

  // A fresh target, with the schema built by the migrations exactly as production is.
  const su = new Client({ connectionString: SUPER });
  await su.connect();
  await su.query(`drop database if exists ${TARGET_DB} with (force)`);
  await su.query(`create database ${TARGET_DB}`);
  await su.end();

  process.env.DATABASE_SUPER_URL = TARGET;
  const { runMigrations } = await import("./lib-migrate");
  await runMigrations();
  console.log("  target database migrated");

  // Back up the development database.
  const before = await listBackups();
  const result = await backupDatabase({ url: SOURCE, keep: 20 });
  check(
    "a backup is produced and stored",
    result.bytes > 0 && result.rows > 0,
    `${result.tables} tables, ${result.rows} rows, ${(result.bytes / 1024).toFixed(0)} KB gzipped`
  );

  const after = await listBackups();
  check("and appears in storage", after.length === before.length + 1, `${after.length} archive(s)`);

  // Compression is the difference between keeping two weeks and keeping two days.
  const raw = (await q(SOURCE, `select pg_database_size(current_database()) b`)).rows[0].b;
  check(
    "compressed well below the database size",
    result.bytes < Number(raw),
    `${(result.bytes / 1048576).toFixed(1)} MB vs ${(Number(raw) / 1048576).toFixed(1)} MB live`
  );

  // Restore it into the empty target.
  const archive = await readBackup(result.path);
  check("the archive reads back", !!archive, `${archive?.length ?? 0} bytes`);
  const restored = await restoreDatabase(archive!, TARGET);
  check("it restores", restored.rows === result.rows, `${restored.rows} of ${result.rows} rows`);

  // And the content is identical, which is the whole point.
  let bad = 0;
  for (const [label, sql] of CHECKS) {
    const a = (await q(SOURCE, sql)).rows[0].h;
    const b = (await q(TARGET, sql)).rows[0].h;
    if (a !== b) bad++;
    check(`  ${label} identical`, a === b);
  }
  check("every content check matched", bad === 0, `${bad} mismatched`);

  // Foreign keys were bypassed during the load; they must hold afterwards.
  const invalid = (
    await q(
      TARGET,
      `select count(*)::int n from pg_constraint where contype='f' and not convalidated`
    )
  ).rows[0].n;
  check("every foreign key is valid after restore", Number(invalid) === 0, `${invalid} unvalidated`);

  // A restored database has to be usable, not merely present.
  const sample = (
    await q(TARGET, `select full_name from patients where full_name ~ '[؀-ۿ]' limit 1`)
  ).rows[0];
  check("Arabic reads correctly out of the restored copy", !!sample?.full_name, sample?.full_name);

  const su2 = new Client({ connectionString: SUPER });
  await su2.connect();
  await su2.query(`drop database if exists ${TARGET_DB} with (force)`);
  await su2.end();

  console.log(`\n  backup: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("QA FAILED:", (e as Error).message);
  process.exit(1);
});
