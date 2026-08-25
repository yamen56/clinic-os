import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

const PG_PORT = Number(process.env.PG_PORT || 5544);

/**
 * Migrations run as a superuser: they create the `clinicos_app` role and the
 * RLS policies bound to it. Locally that is the embedded server's postgres
 * user. Against a hosted provider set
 * DATABASE_SUPER_URL to its owner connection string.
 */
const REMOTE = process.env.DATABASE_SUPER_URL;

/** Kept in step with `sslFor` in src/lib/db.ts — see the reasoning there. */
const sslFor = (url: string) =>
  process.env.PGSSL === "disable" || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)
    ? undefined
    : { rejectUnauthorized: false };

function connect(db: string): Client {
  const url = REMOTE ?? `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${db}`;
  return new Client({ connectionString: url, ssl: sslFor(url) });
}

export async function ensureDatabase() {
  // Hosted providers supply the database; we only create one for local dev.
  if (REMOTE) return;
  const client = connect("postgres");
  await client.connect();
  const r = await client.query("select 1 from pg_database where datname = 'clinicos'");
  if (r.rowCount === 0) {
    await client.query("create database clinicos");
    console.log("[db] created database clinicos");
  }
  await client.end();
}

export async function runMigrations() {
  const client = connect("clinicos");
  await client.connect();
  await client.query(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())"
  );
  const dir = path.join(process.cwd(), "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set<string>(
    (await client.query("select name from _migrations")).rows.map((r: { name: string }) => r.name)
  );
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    console.log(`[db] applying ${f}`);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into _migrations (name) values ($1)", [f]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      await client.end();
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  // Re-grant so new tables are reachable by the app role (RLS still applies).
  await client.query(`
    grant usage on schema public to clinicos_app;
    grant select, insert, update, delete on all tables in schema public to clinicos_app;
    grant usage, select on all sequences in schema public to clinicos_app;
    grant execute on all functions in schema public to clinicos_app;
  `);
  // Production sets a real password for the app role; dev keeps the default.
  // Quoted as a literal because ALTER ROLE does not accept bind parameters.
  if (process.env.APP_DB_PASSWORD) {
    const pw = process.env.APP_DB_PASSWORD.replace(/'/g, "''");
    await client.query(`alter role clinicos_app with password '${pw}'`);
    console.log("[db] app role password updated");
  }
  await client.end();
  console.log("[db] migrations up to date");
}
