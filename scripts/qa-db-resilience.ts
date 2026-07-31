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
import { withCtx, withSystem, getPool, activeRoute, sslFor } from "../src/lib/db";

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
  // Each block gets a clean breaker, or one block's failures suppress the next
  // block's connect attempts and the timings stop meaning anything.
  globalThis.__cosPrimaryDownUntil = undefined;
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
    globalThis.__cosPrimaryDownUntil = undefined;
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
  }
}

async function main() {
  console.log("▶ database resilience");

  /* --------------------------------- 0. TLS is asked for where it exists */
  /*
    node-pg negotiates SSL whenever an ssl object is given, and a server that
    does not offer it refuses the connection outright rather than falling back.
    So this decision is load-bearing in both directions: demand TLS from a
    provider's private network and nothing connects at all; skip it for a public
    host and credentials cross the internet in the clear.
  */
  for (const [url, wantTls, why] of [
    ["postgres://u:p@localhost:5432/db", false, "local"],
    ["postgres://u:p@127.0.0.1:5544/clinicos", false, "local ip"],
    // Measured: Railway's postgres-ssl image accepts TLS on its private domain
    // as well as its public proxy, so the private network gets it too.
    ["postgres://u:p@postgres.railway.internal:5432/railway", true, "railway private network"],
    ["postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres", true, "supabase"],
    ["postgres://u:p@db.abc.supabase.co:5432/postgres", true, "supabase direct"],
    ["postgres://u:p@some-host.example.com:5432/db", true, "public host"],
  ] as [string, boolean, string][]) {
    const got = sslFor(url) !== undefined;
    check(
      `TLS ${wantTls ? "required" : "skipped"} for ${why}`,
      got === wantTls,
      got ? "ssl on" : "ssl off"
    );
  }

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
    /*
      Bounded. Measured in production: a pooler in trouble takes ~3s to refuse,
      and three of those made a page spin for fifteen seconds before showing the
      same error. A fast-refusing socket like this one still gets every attempt.
    */
    check(
      "and stays inside the connect budget",
      elapsed < 4000,
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

  /* ------------------- 3b. the direct route carries the app when the pooler dies */
  /*
    The case this was built for: Supabase's pooler unreachable for hours while
    Postgres itself is fine. A dead primary plus a live fallback must serve, not
    fail — and must then stop paying the primary's retry on every request.
  */
  {
    const prevPool = globalThis.__cosPool;
    const prevFallback = globalThis.__cosFallbackPool;
    const prevUrl = process.env.DATABASE_URL;
    const prevFbUrl = process.env.DATABASE_FALLBACK_URL;
    globalThis.__cosPool = undefined;
    globalThis.__cosFallbackPool = undefined;
    globalThis.__cosFallbackUntil = undefined;
    process.env.DATABASE_URL = DEAD;
    process.env.DATABASE_FALLBACK_URL = LIVE;

    try {
      const t0 = Date.now();
      const n = await withSystem(async (c) => (await c.query("select 7 as n")).rows[0].n);
      const firstMs = Date.now() - t0;
      check("a dead pooler falls back to the direct route", Number(n) === 7, `${firstMs}ms`);
      check("and the health route reports it", activeRoute() === "fallback", activeRoute());

      // Second call must skip the dead primary entirely.
      const t1 = Date.now();
      await withSystem(async (c) => c.query("select 1"));
      const secondMs = Date.now() - t1;
      check(
        "later requests skip the dead primary rather than re-paying its retry",
        secondMs < firstMs && secondMs < 400,
        `${secondMs}ms vs ${firstMs}ms`
      );
    } finally {
      try {
        await (globalThis.__cosPool as Pool | undefined)?.end();
      } catch {}
      try {
        await (globalThis.__cosFallbackPool as Pool | undefined)?.end();
      } catch {}
      globalThis.__cosPool = prevPool;
      globalThis.__cosFallbackPool = prevFallback;
      globalThis.__cosFallbackUntil = undefined;
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
      if (prevFbUrl === undefined) delete process.env.DATABASE_FALLBACK_URL;
      else process.env.DATABASE_FALLBACK_URL = prevFbUrl;
    }
  }

  /* ------------- 1b. a page of several queries pays the outage cost once */
  await withPool(DEAD, async () => {
    const t0 = Date.now();
    await withSystem(async (c) => c.query("select 1")).catch(() => null);
    const first = Date.now() - t0;

    // What a real page does: several separate acquisitions in a row.
    const t1 = Date.now();
    for (let i = 0; i < 3; i++) {
      await withSystem(async (c) => c.query("select 1")).catch(() => null);
    }
    const nextThree = Date.now() - t1;

    check(
      "the next three queries do not each re-test a database known to be down",
      nextThree < first,
      `${nextThree}ms for three, vs ${first}ms for the first`
    );
    check("they fail almost immediately", nextThree < 300, `${nextThree}ms`);
  });

  /* ---------- 1c. a busy pool is not an outage, and must not become one */
  /*
    The trap this guards: pg rejects with "timeout exceeded when trying to
    connect" when every pooled connection is in use. That says nothing about the
    database. If it opened the breaker, a burst of traffic would fail every
    query for two seconds — manufacturing an outage at exactly the busiest
    moment.
  */
  await withPool(LIVE, async () => {
    const prevMax = process.env.PG_POOL_MAX;
    const prevTimeout = process.env.PG_CONNECT_TIMEOUT_MS;
    process.env.PG_POOL_MAX = "1";
    process.env.PG_CONNECT_TIMEOUT_MS = "300";
    globalThis.__cosPool = undefined;
    globalThis.__cosPrimaryDownUntil = undefined;

    try {
      // Hold the single connection, then ask for another: guaranteed timeout.
      const held = await getPool().connect();
      let exhausted: Error | null = null;
      await getPool()
        .connect()
        .catch((e) => {
          exhausted = e as Error;
        });
      held.release();

      check(
        "a saturated pool times out",
        !!exhausted && /timeout exceeded/i.test((exhausted as unknown as Error).message),
        (exhausted as unknown as Error | null)?.message?.slice(0, 45)
      );
      check(
        "but is never mistaken for the database being down",
        globalThis.__cosPrimaryDownUntil === undefined
      );

      // And the pool still works immediately afterwards.
      const n = await withSystem(async (c) => (await c.query("select 5 as n")).rows[0].n);
      check("so the next query succeeds normally", Number(n) === 5);
    } finally {
      if (prevMax === undefined) delete process.env.PG_POOL_MAX;
      else process.env.PG_POOL_MAX = prevMax;
      if (prevTimeout === undefined) delete process.env.PG_CONNECT_TIMEOUT_MS;
      else process.env.PG_CONNECT_TIMEOUT_MS = prevTimeout;
    }
  });

  /* --------------- 3c. an unroutable fallback is abandoned, not paid for */
  /*
    Measured in production: Railway has no IPv6 egress, so Supabase's AAAA-only
    direct host answers ENETUNREACH every time. Retrying it turned a 1-second
    failure into a 15-second one on every request. It must be tried once and
    then dropped.
  */
  {
    const prevPool = globalThis.__cosPool;
    const prevFallback = globalThis.__cosFallbackPool;
    const prevUrl = process.env.DATABASE_URL;
    const prevFbUrl = process.env.DATABASE_FALLBACK_URL;
    globalThis.__cosPool = undefined;
    globalThis.__cosFallbackPool = undefined;
    globalThis.__cosFallbackUntil = undefined;
    globalThis.__cosFallbackUnusable = undefined;
    process.env.DATABASE_URL = DEAD;
    // A host that cannot resolve stands in for one that cannot be routed to;
    // both surface as `isUnroutable` and must be treated the same.
    process.env.DATABASE_FALLBACK_URL =
      "postgres://u:p@no-such-host.invalid:5432/clinicos";

    try {
      const t0 = Date.now();
      await withSystem(async (c) => c.query("select 1")).catch(() => null);
      const first = Date.now() - t0;

      const t1 = Date.now();
      await withSystem(async (c) => c.query("select 1")).catch(() => null);
      const second = Date.now() - t1;

      check(
        "an unroutable fallback is tried once and abandoned",
        globalThis.__cosFallbackUnusable === true
      );
      check(
        "so later failures cost no more than the primary alone",
        second <= first,
        `${second}ms then, ${first}ms first`
      );
    } finally {
      try {
        await (globalThis.__cosPool as Pool | undefined)?.end();
      } catch {}
      try {
        await (globalThis.__cosFallbackPool as Pool | undefined)?.end();
      } catch {}
      globalThis.__cosPool = prevPool;
      globalThis.__cosFallbackPool = prevFallback;
      globalThis.__cosFallbackUntil = undefined;
      globalThis.__cosFallbackUnusable = undefined;
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
      if (prevFbUrl === undefined) delete process.env.DATABASE_FALLBACK_URL;
      else process.env.DATABASE_FALLBACK_URL = prevFbUrl;
    }
  }

  /* ------------------------------------ 4. the health probe tells the truth */
  const { GET } = await import("../src/app/api/health/route");

  await withPool(LIVE, async () => {
    const res = await GET();
    const body = (await res.json()) as { ok: boolean; db: { ok: boolean; ms: number | null } };
    check("a healthy platform reports 200", res.status === 200, String(res.status));
    check("and says the database is reachable", body.ok && body.db.ok, JSON.stringify(body.db));
  });

  await withPool(DEAD, async () => {
    const t0 = Date.now();
    const res = await GET();
    const body = (await res.json()) as { ok: boolean; db: { ok: boolean; error?: string } };
    const elapsed = Date.now() - t0;
    check("an unreachable database reports 503", res.status === 503, String(res.status));
    check("and says so rather than throwing", body.ok === false && !body.db.ok);
    check("carrying the reason", !!body.db.error, body.db.error?.slice(0, 40));
    // A probe that hangs is worse than one that fails: the monitor learns nothing.
    check("without hanging the monitor", elapsed < 12000, `${elapsed}ms`);
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
