import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

const PG_PORT = Number(process.env.PG_PORT || 5544);
const SUPER = (db: string) => `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${db}`;

export async function ensureDatabase() {
  const client = new Client({ connectionString: SUPER("postgres") });
  await client.connect();
  const r = await client.query("select 1 from pg_database where datname = 'clinicos'");
  if (r.rowCount === 0) {
    await client.query("create database clinicos");
    console.log("[db] created database clinicos");
  }
  await client.end();
}

export async function runMigrations() {
  const client = new Client({ connectionString: SUPER("clinicos") });
  await client.connect();
  await client.query(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())"
  );
  const dir = path.join(process.cwd(), "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set(
    (await client.query("select name from _migrations")).rows.map((r) => r.name)
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
  await client.end();
  console.log("[db] migrations up to date");
}
