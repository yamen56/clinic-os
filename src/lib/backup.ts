import { Client } from "pg";
import { createGzip, gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { saveSystemFile, listSystemFiles, openFile, deleteFile } from "./storage";

/**
 * Logical backups of the whole database.
 *
 * The database moved onto a volume we own, which means recovery is now ours to
 * arrange. Railway snapshots the volume, but that protects against the disk
 * failing — not against the far likelier accident: a bad migration, a mistaken
 * delete, a bug that quietly corrupts a column. Those replicate into a snapshot
 * as faithfully as anything else.
 *
 * So this is a *logical* backup — the rows themselves, in Postgres' own COPY
 * text format. Two properties matter and neither is available from a volume
 * snapshot:
 *
 *   portable — it restores into any Postgres anywhere. Railway, Supabase, a
 *     laptop. Nothing about it is tied to the host it came from, which is what
 *     stops a hosting problem from becoming a data problem.
 *   inspectable — it is text. When something has gone wrong you can read it,
 *     grep it, and restore one table rather than the world.
 *
 * COPY rather than INSERT statements for the reason the migrator uses it too:
 * jsonb, arrays, numerics and Arabic cross unchanged, with no marshalling
 * through JavaScript types to get them subtly wrong.
 */

const require_ = createRequire(import.meta.url);

type CopyStreams = {
  from: (sql: string) => Writable;
  to: (sql: string) => Readable;
};

/**
 * `pg-copy-streams` is a devDependency — a backup runs in the worker, which
 * installs dev deps, but this keeps the failure legible if that ever changes.
 */
function copyStreams(): CopyStreams {
  try {
    return require_("pg-copy-streams") as CopyStreams;
  } catch {
    throw new Error("backups need pg-copy-streams (npm i pg-copy-streams)");
  }
}

/** Marks the start of a table's data inside the archive. */
const TABLE_MARKER = "-- @table ";

function connect(url: string): Client {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return new Client({
    connectionString: url,
    ssl: process.env.PGSSL === "disable" || local ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 0,
  } as never);
}

async function tablesOf(c: Client): Promise<string[]> {
  const r = await c.query<{ name: string }>(
    `select c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`
  );
  return r.rows.map((x) => x.name);
}

export type BackupResult = { path: string; bytes: number; tables: number; rows: number };

/**
 * Dumps every table and stores the archive.
 *
 * `_migrations` is included deliberately: restoring into an empty database
 * needs to know which schema version these rows belong to, and finding that out
 * afterwards is guesswork.
 */
export async function backupDatabase(opts: { url?: string; keep?: number } = {}): Promise<BackupResult> {
  const url = opts.url ?? process.env.DATABASE_SUPER_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("no database URL for backup");
  const copy = copyStreams();

  const c = connect(url);
  await c.connect();

  const chunks: Buffer[] = [];
  const gzip = createGzip({ level: 9 });
  const sink = new PassThrough();
  sink.on("data", (b: Buffer) => chunks.push(b));
  const done = pipeline(gzip, sink);

  const write = (s: string) =>
    new Promise<void>((resolve, reject) =>
      gzip.write(s, (e) => (e ? reject(e) : resolve()))
    );

  let rows = 0;
  const tables = await tablesOf(c);

  await write(
    `-- clinic-os logical backup\n-- created ${new Date().toISOString()}\n-- tables ${tables.length}\n`
  );

  for (const t of tables) {
    const n = Number(
      (await c.query<{ n: string }>(`select count(*)::text as n from "${t}"`)).rows[0].n
    );
    rows += n;
    await write(`${TABLE_MARKER}${t} ${n}\n`);
    if (n === 0) continue;
    // node-pg's types do not describe the COPY submittable; see copy-database.ts.
    const submit = c.query.bind(c) as unknown as (s: unknown) => Readable;
    const reader = submit(copy.to(`copy "${t}" to stdout`));
    for await (const chunk of reader) gzip.write(chunk as Buffer);
    // COPY's own end-of-data marker, so a restore can stream straight into it.
    await write("\\.\n");
  }

  gzip.end();
  await done;
  await c.end();

  const data = Buffer.concat(chunks);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const saved = await saveSystemFile("backups", `clinicos-${stamp}.sql.gz`, data);

  await prune(opts.keep ?? 14);

  return { path: saved.storagePath, bytes: saved.sizeBytes, tables: tables.length, rows };
}

/** Keeps the newest `keep` archives and removes the rest. */
async function prune(keep: number): Promise<void> {
  if (keep <= 0) return;
  const all = await listSystemFiles("backups");
  // Names are ISO-stamped, so lexical order is chronological.
  const stale = all.slice(0, Math.max(0, all.length - keep));
  for (const key of stale) await deleteFile(key).catch(() => {});
}

/**
 * Restores an archive into a database whose schema already exists.
 *
 * Deliberately not "restore into anything": the schema comes from the
 * migrations, so a restored database is built the same way production was
 * rather than inheriting whatever the archive happened to carry.
 */
export async function restoreDatabase(archive: Buffer, url: string): Promise<{ tables: number; rows: number }> {
  const copy = copyStreams();
  const text = gunzipSync(archive).toString("utf8");
  const c = connect(url);
  await c.connect();

  // Foreign keys are checked by triggers; the archive is in alphabetical order,
  // not dependency order. Re-validated below rather than trusted.
  await c.query("set session_replication_role = replica");

  const lines = text.split("\n");
  let i = 0;
  let tables = 0;
  let rows = 0;

  // Empty first, or a restore into a live database doubles everything.
  const present = await tablesOf(c);
  if (present.length) {
    await c.query(`truncate table ${present.map((t) => `"${t}"`).join(", ")} cascade`);
  }

  while (i < lines.length) {
    const line = lines[i++];
    if (!line.startsWith(TABLE_MARKER)) continue;
    const [name, countText] = line.slice(TABLE_MARKER.length).split(" ");
    const expected = Number(countText);
    tables++;
    if (expected === 0) continue;

    const body: string[] = [];
    while (i < lines.length && lines[i] !== "\\.") body.push(lines[i++]);
    i++; // step past the terminator

    const submit = c.query.bind(c) as unknown as (s: unknown) => Writable;
    const writer = submit(copy.from(`copy "${name}" from stdin`));
    await pipeline(Readable.from([body.join("\n") + "\n"]), writer);
    rows += expected;
  }

  await c.query("set session_replication_role = origin");

  const fks = await c.query<{ tbl: string; con: string }>(
    `select c.relname as tbl, con.conname as con
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where con.contype = 'f' and n.nspname = 'public'`
  );
  for (const f of fks.rows) {
    await c.query(`alter table "${f.tbl}" validate constraint "${f.con}"`);
  }

  await c.end();
  return { tables, rows };
}

/** Fetches an archive back out of storage. */
export async function readBackup(storagePath: string): Promise<Buffer | null> {
  const f = await openFile(storagePath);
  return f?.data ?? null;
}

export async function listBackups(): Promise<string[]> {
  return listSystemFiles("backups");
}
