/**
 * Reaching the backups, and putting one back.
 *
 * The archives live in object storage under `_system/backups/` and nothing in
 * the product downloads them, deliberately: each file is every patient record
 * in every clinic, and a button on an admin page would put the whole database
 * one compromised session away from walking out. So retrieval is a deliberate
 * act, performed here, by somebody holding the storage credentials.
 *
 * Reads `.env.production.local` rather than taking connection strings on the
 * command line, like `migrate-prod.ts`, so no password reaches a shell history
 * or a process list.
 *
 *   npx tsx scripts/restore.ts                       list the archives
 *   npx tsx scripts/restore.ts --verify              restore the newest into a
 *                                                    throwaway local database,
 *                                                    report what came back, drop it
 *   npx tsx scripts/restore.ts --verify --archive clinicos-2026-09-04T19-11-31.sql.gz
 *
 *   npx tsx scripts/restore.ts --into-production \
 *       --archive <name> --confirm <database name>   put one back. Destructive.
 *
 * `--verify` is the one to run on a schedule. A backup nobody has restored is a
 * belief rather than a safeguard, and the day you discover which it was is
 * always the worst available day.
 */
import { Client } from "pg";

process.loadEnvFile(".env.production.local");

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const LOCAL_PORT = process.env.PG_PORT || 5544;
const LOCAL_SUPER = `postgres://postgres:postgres@127.0.0.1:${LOCAL_PORT}/postgres`;
const VERIFY_DB = "clinicos_restorecheck";

function ageOf(takenAt: Date | null): string {
  if (!takenAt) return "unknown";
  const h = (Date.now() - takenAt.getTime()) / 3_600_000;
  return h < 48 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`;
}

async function list() {
  const { listBackupDetails } = await import("../src/lib/backup");
  const all = await listBackupDetails();
  if (!all.length) {
    console.log("\nNo archives. The database is not backed up.\n");
    process.exitCode = 1;
    return;
  }
  console.log(`\n${all.length} archive(s) in ${process.env.S3_BUCKET ?? "local storage"}/_system/backups/\n`);
  for (const b of [...all].reverse()) {
    console.log(
      `  ${b.name}  ${(b.bytes / 1048576).toFixed(2).padStart(8)} MB  ${ageOf(b.takenAt)}`
    );
  }
  console.log("");
}

/** Pulls an archive back and restores it into a scratch database, then drops it. */
async function verify() {
  const { listBackupDetails, readBackup, restoreDatabase } = await import("../src/lib/backup");
  const all = await listBackupDetails();
  const wanted = value("--archive");
  const entry = wanted ? all.find((b) => b.name === wanted) : all[all.length - 1];
  if (!entry) {
    console.error(wanted ? `no archive named ${wanted}` : "there are no archives to verify");
    process.exit(1);
  }
  console.log(`\nverifying ${entry.name} (${(entry.bytes / 1048576).toFixed(2)} MB, ${ageOf(entry.takenAt)})`);

  const su = new Client({ connectionString: LOCAL_SUPER });
  await su.connect();
  await su.query(`drop database if exists ${VERIFY_DB} with (force)`);
  await su.query(`create database ${VERIFY_DB}`);
  await su.end();

  /*
    The schema comes from the migrations, not from the archive — a restored
    database is built exactly the way production was, rather than inheriting
    whatever shape the dump happened to carry. `runMigrations` reads
    DATABASE_SUPER_URL, so it is pointed at the scratch database and put back
    immediately: leaving it changed would aim the next thing that reads it at
    the wrong server.
  */
  const target = `postgres://postgres:postgres@127.0.0.1:${LOCAL_PORT}/${VERIFY_DB}`;
  const realSuper = process.env.DATABASE_SUPER_URL;
  const realApp = process.env.APP_DB_PASSWORD;
  process.env.DATABASE_SUPER_URL = target;
  /*
    And the app role's password is left alone. Postgres roles are cluster-wide,
    so a migration run carrying the production password would silently reset the
    local `clinicos_app` login and break every other thing on this machine —
    which is exactly what happened the first time this drill was performed by
    hand.
  */
  delete process.env.APP_DB_PASSWORD;
  try {
    const { runMigrations } = await import("./lib-migrate");
    await runMigrations();
  } finally {
    process.env.DATABASE_SUPER_URL = realSuper;
    if (realApp !== undefined) process.env.APP_DB_PASSWORD = realApp;
  }

  const archive = await readBackup(entry.key);
  if (!archive) {
    console.error("the archive could not be read back out of storage");
    process.exit(1);
  }
  const r = await restoreDatabase(archive, target);
  console.log(`restored ${r.rows} rows across ${r.tables} tables\n`);

  const c = new Client({ connectionString: target });
  await c.connect();
  const counts: [string, string][] = [
    ["clinics", "select count(*)::int n from clinics"],
    ["patients", "select count(*)::int n from patients"],
    ["appointments", "select count(*)::int n from appointments"],
    ["invoices", "select count(*)::int n from invoices"],
    ["messages", "select count(*)::int n from messages"],
    ["documents", "select count(*)::int n from documents"],
  ];
  for (const [label, sql] of counts) {
    console.log(`  ${label.padEnd(14)} ${(await c.query(sql)).rows[0].n}`);
  }
  // Arabic is the thing a careless dump mangles first, so it is checked by eye.
  const ar = (await c.query(`select full_name from patients where full_name ~ '[؀-ۿ]' limit 1`)).rows[0];
  console.log(`  ${"arabic".padEnd(14)} ${ar?.full_name ?? "(none found)"}`);
  const unvalidated = (
    await c.query(`select count(*)::int n from pg_constraint where contype='f' and not convalidated`)
  ).rows[0].n;
  console.log(`  ${"broken keys".padEnd(14)} ${unvalidated}`);
  await c.end();

  const su2 = new Client({ connectionString: LOCAL_SUPER });
  await su2.connect();
  await su2.query(`drop database if exists ${VERIFY_DB} with (force)`);
  await su2.end();

  const ok = Number(unvalidated) === 0 && r.rows > 0;
  console.log(ok ? "\nVERIFIED — this archive restores cleanly.\n" : "\nFAILED — do not rely on this archive.\n");
  if (!ok) process.exitCode = 1;
}

/** Puts an archive back into production. Empties it first. */
async function intoProduction() {
  const { listBackupDetails, readBackup, restoreDatabase } = await import("../src/lib/backup");
  const url = process.env.DATABASE_SUPER_URL;
  if (!url) {
    console.error("DATABASE_SUPER_URL is not set in .env.production.local");
    process.exit(1);
  }
  const dbName = new URL(url).pathname.slice(1);

  const wanted = value("--archive");
  if (!wanted) {
    // No defaulting to "the newest" on the destructive path: which archive is
    // being put back is the entire decision, and it should be typed out.
    console.error("--archive is required; run without arguments to list them");
    process.exit(1);
  }
  if (value("--confirm") !== dbName) {
    console.error(
      `refusing: pass --confirm ${dbName} to confirm you mean to empty and rewrite that database`
    );
    process.exit(1);
  }

  const entry = (await listBackupDetails()).find((b) => b.name === wanted);
  if (!entry) {
    console.error(`no archive named ${wanted}`);
    process.exit(1);
  }

  console.log(`\ntarget:  ${new URL(url).host}/${dbName}`);
  console.log(`archive: ${entry.name} (${(entry.bytes / 1048576).toFixed(2)} MB, ${ageOf(entry.takenAt)})`);
  console.log("\nEvery table in that database will be emptied and rewritten from this archive.");
  console.log("Anything written since the archive was taken is lost.\n");

  const archive = await readBackup(entry.key);
  if (!archive) {
    console.error("the archive could not be read back out of storage — nothing was changed");
    process.exit(1);
  }
  const r = await restoreDatabase(archive, url);
  console.log(`restored ${r.rows} rows across ${r.tables} tables`);
  console.log("\nRun the app's health checks before letting anybody back in.\n");
}

async function main() {
  if (has("--into-production")) return intoProduction();
  if (has("--verify")) return verify();
  return list();
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e).slice(0, 500));
  process.exit(1);
});
