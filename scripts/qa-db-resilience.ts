/**
 * Does the app ride out a brief database outage, or turn it into a 500?
 *
 * Written after production spent seven minutes showing "Application error: a
 * server-side exception has occurred" because Supabase's pooler could not reach
 * Postgres. The database recovering on its own is not the fix — surviving the
 * next one is.
 *
 * Two things have to hold, and the second matters as much as the first:
 * connecting is retried when the failure means "nothing ran", and a caller's
 * work is *never* retried, because repeating it could double an insert.
 */
import type { Pool } from "pg";
import { withCtx, withSystem, getPool } from "../src/lib/db";

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

/** A port nothing is listening on, so connecting fails the way an outage does. */
const DEAD = "postgres://clinicos_app:clinicos_app@127.0.0.1:5999/clinicos";
const LIVE =
  process.env.PG_URL || `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

async function withPool(url: string, fn: () => Promise<void>) {
  const previous = globalThis.__cosPool;
  const prevUrl = process.env.DATABASE_URL;
  globalThis.__cosPool = undefined;
  process.env.DATABASE_URL = url;
  try {
    await fn();
  } finally {
    try {
      // Restated: the assignment above narrows the global to `undefined`, but
      // `fn` will have replaced it with the pool this needs to close.
      await (globalThis.__cosPool as Pool | undefined)?.end();
    } catch {}
    globalThis.__cosPool = previous;
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
  }
}

async function main() {
  console.log("▶ database resilience");

  /* ------------------------------------- 1. an unreachable database retries */
  await withPool(DEAD, async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warnings.push(a.join(" "));
    };

    const t0 = Date.now();
    let threw: Error | null = null;
    try {
      await withCtx({ isAdmin: true }, async (c) => {
        await c.query("select 1");
      });
    } catch (e) {
      threw = e as Error;
    }
    const elapsed = Date.now() - t0;
    console.warn = realWarn;

    check("an unreachable database still fails", !!threw, threw?.message.slice(0, 60));
    check(
      "but only after retrying",
      warnings.filter((w) => w.includes("connect retry")).length === 2,
      `${warnings.filter((w) => w.includes("connect retry")).length} retries`
    );
    check(
      "with a backoff, not a tight loop",
      elapsed >= 700,
      `${elapsed}ms`
    );
    check(
      "and gives up rather than hanging the request",
      elapsed < 8000,
      `${elapsed}ms`
    );
  });

  /* --------------------------------- 2. a working database is not slowed down */
  await withPool(LIVE, async () => {
    const t0 = Date.now();
    const r = await withSystem(async (c) => (await c.query("select 42 as n")).rows[0].n);
    const elapsed = Date.now() - t0;
    check("a healthy database answers normally", Number(r) === 42, `${elapsed}ms`);
    check("with no retry penalty", elapsed < 2000, `${elapsed}ms`);
  });

  /* ------------------- 3. the caller's work is never repeated (the safety rule) */
  await withPool(LIVE, async () => {
    await withSystem(async (c) => {
      await c.query(`drop table if exists _qa_retry_probe`);
      await c.query(`create table _qa_retry_probe (n int)`);
    });

    let attempts = 0;
    try {
      await withCtx({ isAdmin: true }, async (c) => {
        attempts++;
        await c.query(`insert into _qa_retry_probe (n) values (1)`);
        // Fails *after* writing — exactly the shape that must not be retried.
        throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
      });
    } catch {
      /* expected */
    }

    check("a failure inside the caller's work runs it once", attempts === 1, `${attempts} attempt(s)`);

    const rows = await withSystem(
      async (c) => (await c.query(`select count(*)::int as n from _qa_retry_probe`)).rows[0].n
    );
    check(
      "and the transaction rolled back, so nothing was written twice",
      Number(rows) === 0,
      `${rows} row(s)`
    );

    await withSystem((c) => c.query(`drop table if exists _qa_retry_probe`));
  });

  try {
    await getPool().end();
  } catch {}

  console.log(`\n  resilience: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
