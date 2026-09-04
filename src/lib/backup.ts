import { Client } from "pg";
import { createGzip, gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { saveSystemStream, listSystemFiles, openFile, deleteFile } from "./storage";

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
 *   portable — it restores into any Postgres anywhere. A managed service, a
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
 * A production dependency, and it has to stay one.
 *
 * This used to say "a backup runs in the worker, which installs dev deps" and
 * `pg-copy-streams` sat in devDependencies on that basis. `Dockerfile.worker`
 * runs `npm ci --omit=dev`, so the require below threw on every tick from the
 * day the feature shipped, the scheduler logged it and moved on, and the
 * database went unbacked-up for five weeks without a single alarm. The comment
 * was the bug: it described an arrangement nobody had checked.
 */
function copyStreams(): CopyStreams {
  try {
    return require_("pg-copy-streams") as CopyStreams;
  } catch {
    throw new Error(
      "backups need pg-copy-streams as a *production* dependency — the worker image installs with --omit=dev"
    );
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
export async function backupDatabase(
  opts: { url?: string; keep?: number; keepMonthly?: number } = {}
): Promise<BackupResult> {
  const url = opts.url ?? process.env.DATABASE_SUPER_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("no database URL for backup");
  const copy = copyStreams();

  const c = connect(url);
  await c.connect();

  const counts = { rows: 0, tables: 0 };

  /*
    The archive as a generator rather than as a buffer.

    Every byte used to be kept in `chunks` and then copied again by
    `Buffer.concat`, so a backup needed roughly twice the compressed archive
    resident at once — fine at today's 0.1 MB and fatal at a few hundred
    clinics, where the job that protects the data would be the job that runs the
    worker out of heap. Yielding lets `pipeline` apply backpressure: the dump
    goes out to storage as fast as storage accepts it and no faster, and nothing
    but the part in flight is ever held.
  */
  async function* archive(tables: string[]): AsyncGenerator<string | Buffer> {
    yield `-- clinic-os logical backup\n-- created ${new Date().toISOString()}\n-- tables ${tables.length}\n`;
    for (const t of tables) {
      /*
        An exact count, not an estimate from the planner: `restoreDatabase`
        skips a section it is told holds zero rows, so a table under-counted to
        0 would restore as empty and nothing would say so.
      */
      const n = Number(
        (await c.query<{ n: string }>(`select count(*)::text as n from "${t}"`)).rows[0].n
      );
      counts.rows += n;
      yield `${TABLE_MARKER}${t} ${n}\n`;
      if (n === 0) continue;
      // node-pg's types do not describe the COPY submittable; see copy-database.ts.
      const submit = c.query.bind(c) as unknown as (s: unknown) => Readable;
      const reader = submit(copy.to(`copy "${t}" to stdout`));
      for await (const chunk of reader) yield chunk as Buffer;
      // COPY's own end-of-data marker, so a restore can stream straight into it.
      yield "\\.\n";
    }
  }

  const tables = await tablesOf(c);
  counts.tables = tables.length;

  const gzip = createGzip({ level: 9 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  /*
    Both halves started together: the uploader reads the compressed side while
    the generator fills the other. Awaiting them in sequence would deadlock —
    gzip's buffer fills, the generator blocks, and nothing is ever read.
  */
  const uploading = saveSystemStream("backups", `clinicos-${stamp}.sql.gz`, gzip);
  // Kept from going unhandled if the pipeline below fails first.
  uploading.catch(() => {});
  let saved: { storagePath: string; sizeBytes: number };
  try {
    await pipeline(Readable.from(archive(tables)), gzip);
    saved = await uploading;
  } finally {
    await c.end().catch(() => {});
  }

  await prune(opts.keep ?? 14, opts.keepMonthly ?? 12);

  return { path: saved.storagePath, bytes: saved.sizeBytes, tables: counts.tables, rows: counts.rows };
}

/**
 * Retention, in two tiers.
 *
 * A fortnight of nightly archives answers "somebody deleted the wrong thing on
 * Tuesday". It does not answer the slower question — a column quietly corrupted
 * by a bug that shipped in March and noticed in June — because by then every
 * archive that predates the damage has been pruned. So the first archive of
 * each month is also kept, for a year by default: twelve extra files, and the
 * difference between a recoverable mistake and a permanent one.
 */
async function prune(keepDaily: number, keepMonthly: number): Promise<void> {
  if (keepDaily <= 0) return;
  // Names are ISO-stamped, so lexical order is chronological.
  const all = await listSystemFiles("backups");
  const keep = new Set(all.slice(-keepDaily));

  const firstOfMonth = new Map<string, string>();
  for (const key of all) {
    const m = /clinicos-(\d{4}-\d{2})-/.exec(key);
    if (m && !firstOfMonth.has(m[1])) firstOfMonth.set(m[1], key);
  }
  for (const key of [...firstOfMonth.values()].slice(-keepMonthly)) keep.add(key);

  for (const key of all) if (!keep.has(key)) await deleteFile(key).catch(() => {});
}

/**
 * When the newest archive was taken, or null if there are none at all.
 *
 * Read from the object name rather than from its upload time: the name is the
 * moment the dump began, which is what "how far back can we go" actually means.
 */
export async function newestBackupAt(): Promise<Date | null> {
  const all = await listSystemFiles("backups");
  const last = all[all.length - 1];
  if (!last) return null;
  const m = /clinicos-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(last);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

/** Hours since the last archive; Infinity when there has never been one. */
export async function backupAgeHours(): Promise<number> {
  const at = await newestBackupAt();
  return at ? (Date.now() - at.getTime()) / 3_600_000 : Infinity;
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
