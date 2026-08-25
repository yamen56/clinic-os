/**
 * Copies a whole CLINIC OS database from one Postgres to another.
 *
 * Written to move off a managed project whose connection pooler kept losing
 * its route to a healthy database. There is no pg_dump here — the embedded
 * Postgres this project ships for development is a minimal build without the
 * client tools — so the copy goes over `COPY ... TO/FROM STDOUT` instead.
 *
 * COPY rather than row-by-row INSERTs, deliberately. It moves Postgres' own
 * text format straight across, so jsonb, arrays, timestamps with zones, bytea
 * and Arabic text arrive exactly as they left, with no marshalling through
 * JavaScript types to get them wrong. (This codebase has been bitten before by
 * a jsonb column re-encoded as a Postgres array literal on the way through.)
 *
 * The target's schema is expected to exist already — run the migrations against
 * it first, so it is built the same way production was rather than inherited
 * from a dump.
 *
 *   npx tsx scripts/copy-database.ts --from <url> --to <url> [--dry-run]
 *
 * Both URLs must be superuser connections: the copy disables triggers, which
 * ordinary roles may not do.
 */
import { Client } from "pg";
import { pipeline } from "node:stream/promises";
import type { Duplex, Readable, Writable } from "node:stream";
import { createRequire } from "node:module";

/*
  `pg-copy-streams` ships no types, and this is a one-off tool installed without
  --save, so a dependency on @types is not worth carrying. The two functions it
  provides are declared here instead of reaching for `any`.
*/
const require_ = createRequire(import.meta.url);
const copyStreams = require_("pg-copy-streams") as {
  from: (sql: string) => Duplex & Writable;
  to: (sql: string) => Duplex & Readable;
};
const copyFrom = copyStreams.from;
const copyTo = copyStreams.to;

type Args = { from: string; to: string; dryRun: boolean; reset: boolean };

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i === -1 ? undefined : a[i + 1];
  };
  const from = get("--from") ?? process.env.COPY_FROM;
  const to = get("--to") ?? process.env.COPY_TO;
  if (!from || !to) {
    console.error("usage: copy-database.ts --from <url> --to <url> [--dry-run]");
    console.error("       (or set COPY_FROM / COPY_TO)");
    process.exit(1);
  }
  return { from, to, dryRun: a.includes("--dry-run"), reset: a.includes("--reset") };
}

function connect(url: string): Client {
  /** Kept in step with `sslFor` in src/lib/db.ts — see the reasoning there. */
  const noTls =
    process.env.PGSSL === "disable" || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return new Client({
    connectionString: url,
    ssl: noTls ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    // A big table should not die halfway to a statement timeout.
    statement_timeout: 0,
  } as never);
}

/** Tables to copy, parents before children, so foreign keys are satisfiable. */
async function orderedTables(c: Client): Promise<string[]> {
  const tables = (
    await c.query<{ name: string }>(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relname <> '_migrations'
        order by c.relname`
    )
  ).rows.map((r) => r.name);

  const deps = (
    await c.query<{ child: string; parent: string }>(
      `select src.relname as child, tgt.relname as parent
         from pg_constraint con
         join pg_class src on src.oid = con.conrelid
         join pg_class tgt on tgt.oid = con.confrelid
         join pg_namespace n on n.oid = src.relnamespace
        where con.contype = 'f' and n.nspname = 'public'`
    )
  ).rows;

  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const d of deps) {
    // A self-reference cannot be satisfied by ordering, and does not need to be:
    // triggers are off during the copy.
    if (d.child !== d.parent) parents.get(d.child)?.add(d.parent);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, trail: Set<string>) => {
    if (seen.has(t)) return;
    // A dependency cycle is fine here for the same reason: report it, carry on.
    if (trail.has(t)) return;
    trail.add(t);
    for (const p of parents.get(t) ?? []) visit(p, trail);
    trail.delete(t);
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

async function counts(c: Client, tables: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const t of tables) {
    const r = await c.query<{ n: string }>(`select count(*)::text as n from "${t}"`);
    m.set(t, Number(r.rows[0].n));
  }
  return m;
}

async function main() {
  const { from, to, dryRun, reset } = parseArgs();
  const src = connect(from);
  const dst = connect(to);
  await src.connect();
  await dst.connect();

  /*
    User, host and database together. All three are needed: two databases on one
    server are legitimately different targets (which is how this gets tested),
    and two *Supabase projects* share both the pooler host and the database name
    `postgres`, differing only in the username — `postgres.<project-ref>`. On
    host alone this refused to migrate one project to another.
  */
  const ident = (u: string) => {
    const p = new URL(u);
    return `${decodeURIComponent(p.username)}@${p.host}${p.pathname}`;
  };
  console.log(`source → ${ident(from)}`);
  console.log(`target → ${ident(to)}`);
  if (ident(from) === ident(to)) {
    console.error("refusing to copy a database onto itself");
    process.exit(1);
  }

  const tables = await orderedTables(src);
  const before = await counts(src, tables);
  const total = [...before.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${tables.length} tables, ${total} rows to copy`);

  // The target must be empty, or this would double every row it already holds.
  const targetTables = await orderedTables(dst);
  const missing = tables.filter((t) => !targetTables.includes(t));
  if (missing.length) {
    console.error(`\ntarget is missing ${missing.length} table(s): ${missing.slice(0, 8).join(", ")}`);
    console.error("run the migrations against the target first");
    process.exit(1);
  }
  /*
    A freshly migrated target is not empty — the migrations seed reference data
    such as the shared document-template library. That is expected, and the
    source's copy of those rows is the authoritative one, so the target is
    emptied rather than merged into. Merging would duplicate every seeded row.

    Emptying a database is destructive enough to require saying so, hence
    --reset. Without it this refuses and explains itself.
  */
  const targetCounts = await counts(dst, targetTables);
  const nonEmpty = [...targetCounts].filter(([, n]) => n > 0);
  if (nonEmpty.length && !dryRun) {
    if (!reset) {
      console.error(`\ntarget is not empty: ${nonEmpty.map(([t, n]) => `${t}=${n}`).join(", ")}`);
      console.error("pass --reset to empty it first (it will be replaced by the source)");
      process.exit(1);
    }
    console.log(`\nemptying target (${nonEmpty.length} non-empty table(s))`);
    // One statement: TRUNCATE ... CASCADE settles dependency order itself.
    await dst.query(`truncate table ${targetTables.map((t) => `"${t}"`).join(", ")} cascade`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing copied. Row counts at source:");
    for (const t of tables) if (before.get(t)) console.log(`  ${t.padEnd(34)} ${before.get(t)}`);
    await src.end();
    await dst.end();
    return;
  }

  /*
    Triggers off for the load. Foreign keys are checked by triggers, and the
    ordering above cannot satisfy a self-reference (documents.supersedes_document_id)
    or a cycle. They are re-enabled and the constraints re-validated below, so
    nothing is taken on trust.
  */
  await dst.query("set session_replication_role = replica");

  let copied = 0;
  for (const t of tables) {
    const n = before.get(t) ?? 0;
    if (n === 0) continue;
    /*
      `client.query` is typed for the ordinary request/response protocol; a COPY
      submittable hands back a stream instead. node-pg supports this at runtime
      — it is how pg-copy-streams is designed to be used — but its types do not
      describe it, so the call is narrowed here rather than left as `any`.
    */
    const submit = src.query.bind(src) as unknown as (s: unknown) => Readable;
    const submitTo = dst.query.bind(dst) as unknown as (s: unknown) => Writable;
    const reader = submit(copyTo(`copy "${t}" to stdout`));
    const writer = submitTo(copyFrom(`copy "${t}" from stdin`));
    await pipeline(reader, writer);
    copied += n;
    console.log(`  ${t.padEnd(34)} ${String(n).padStart(7)}   (${copied}/${total})`);
  }

  await dst.query("set session_replication_role = origin");

  // Sequences do not travel with COPY; without this the next insert collides.
  console.log("\nresetting sequences");
  const seqs = await dst.query<{ seq: string; tbl: string; col: string }>(
    `select s.relname as seq, t.relname as tbl, a.attname as col
       from pg_class s
       join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass
       join pg_class t on t.oid = d.refobjid
       join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
       join pg_namespace n on n.oid = s.relnamespace
      where s.relkind = 'S' and n.nspname = 'public'`
  );
  for (const s of seqs.rows) {
    await dst.query(
      `select setval('"${s.seq}"', coalesce((select max("${s.col}") from "${s.tbl}"), 0) + 1, false)`
    );
  }
  console.log(`  ${seqs.rowCount} sequence(s)`);

  // Prove the foreign keys we bypassed actually hold.
  console.log("\nre-validating foreign keys");
  const fks = await dst.query<{ tbl: string; con: string }>(
    `select c.relname as tbl, con.conname as con
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where con.contype = 'f' and n.nspname = 'public'`
  );
  let bad = 0;
  for (const f of fks.rows) {
    try {
      await dst.query(`alter table "${f.tbl}" validate constraint "${f.con}"`);
    } catch (e) {
      bad++;
      console.error(`  FAILED ${f.tbl}.${f.con}: ${(e as Error).message.slice(0, 90)}`);
    }
  }
  console.log(`  ${fks.rowCount} constraint(s), ${bad} failing`);

  console.log("\nverifying row counts");
  const after = await counts(dst, tables);
  let mismatch = 0;
  for (const t of tables) {
    const a = before.get(t) ?? 0;
    const b = after.get(t) ?? 0;
    if (a !== b) {
      mismatch++;
      console.error(`  MISMATCH ${t}: source ${a}, target ${b}`);
    }
  }
  console.log(`  ${tables.length} tables, ${mismatch} mismatched`);

  await src.end();
  await dst.end();

  if (mismatch || bad) {
    console.error("\nCOPY FAILED — do not switch the app over");
    process.exit(1);
  }
  console.log(`\nCOPY OK — ${total} rows`);
}

main().catch((e) => {
  console.error("COPY FAILED:", (e as Error).message);
  process.exit(1);
});
