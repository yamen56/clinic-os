import { Pool, type PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __cosPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __cosFallbackPool: Pool | undefined;
  /** While set, the fallback route is preferred; see connectWithRetry. */
  // eslint-disable-next-line no-var
  var __cosFallbackUntil: number | undefined;
}

/**
 * Hosted Postgres (Supabase, Neon, Railway) requires TLS; the local embedded
 * server does not offer it. Managed providers commonly present certificates
 * that Node will not chain-verify, so verification is relaxed for remote hosts
 * only — the connection is still encrypted.
 */
function sslFor(url: string) {
  const local = /@(localhost|127.0.0.1|[::1])[:/]/.test(url);
  return local ? undefined : { rejectUnauthorized: false };
}

function primaryUrl(): string {
  return (
    process.env.DATABASE_URL || "postgres://clinicos_app:clinicos_app@127.0.0.1:5544/clinicos"
  );
}

function makePool(url: string, name: string): Pool {
  const p = new Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: Number(process.env.PG_POOL_MAX || 12),
    // A remote database makes a new connection expensive — TCP, TLS, then
    // auth before the first query. Hold idle ones long enough to span the
    // gaps between page views instead of paying that on every navigation.
    idleTimeoutMillis: 60_000,
    keepAlive: true,
    application_name: name,
  });
  p.on("error", (e) => console.error(`[pg pool ${name}]`, e.message));
  return p;
}

export function getPool(): Pool {
  if (!globalThis.__cosPool) globalThis.__cosPool = makePool(primaryUrl(), "clinicos-web");
  return globalThis.__cosPool;
}

/**
 * A second way in, for when the first one is not the database's fault.
 *
 * Supabase puts a pooler (Supavisor) in front of Postgres, and on 2026-07-31 it
 * lost its route to a completely healthy instance three times in ten hours —
 * `pg_postmaster_start_time` showed days of unbroken uptime through every one.
 * With a single connection string there was nothing to do but wait: both pooler
 * ports were dead at once, so this is not something a different port solves.
 *
 * Supabase also publishes a direct host, `db.<ref>.supabase.co`, which does not
 * involve the pooler at all. That is the fallback. It is derived from the
 * primary URL — the pooler username carries the project ref as
 * `user.<ref>` — or given explicitly as DATABASE_FALLBACK_URL.
 *
 * Returns null when there is nothing sensible to fall back to, which is the
 * case locally and for any non-Supabase host. Then everything behaves exactly
 * as it did before.
 */
function getFallbackPool(): Pool | null {
  if (globalThis.__cosFallbackPool) return globalThis.__cosFallbackPool;

  let url = process.env.DATABASE_FALLBACK_URL;
  if (!url) {
    try {
      const u = new URL(primaryUrl());
      const [user, ref] = u.username.split(".");
      // Only Supabase's pooler has this shape, and only it has a direct host.
      if (!ref || !/\.pooler\.supabase\.com$/.test(u.hostname)) return null;
      u.hostname = `db.${ref}.supabase.co`;
      u.port = "5432";
      u.username = user;
      url = u.toString();
    } catch {
      return null;
    }
  }
  globalThis.__cosFallbackPool = makePool(url, "clinicos-web-direct");
  return globalThis.__cosFallbackPool;
}

export type DbCtx = {
  userId?: string | null;
  clinicId?: string | null;
  role?: string | null;
  isAdmin?: boolean;
};

/**
 * Failures that mean "the database was not reachable just now", as opposed to
 * "the database answered and said no".
 *
 * The distinction is the whole point: a constraint violation, a permission
 * error, a syntax error are all answers, and retrying them just wastes time and
 * repeats side effects. These are the ones where nothing ran at all — the
 * pooler was mid-restart, DNS blinked, TLS was reset — and where trying again a
 * second later genuinely works.
 *
 * The Supavisor codes are here because they are what a Supabase blip actually
 * produces: EAUTHQUERY when its credential lookup times out, ECIRCUITBREAKER
 * once it has given up and is refusing new connections for a few seconds.
 */
function isTransientConnectionError(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  const code = String(err?.code ?? "");
  const msg = String(err?.message ?? "");
  return (
    /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)$/.test(code) ||
    /EAUTHQUERY|ECIRCUITBREAKER|econnrefused|Connection terminated|timeout exceeded when trying to connect|server closed the connection|Client has encountered a connection error|terminating connection due to administrator command|the database system is (starting up|shutting down|in recovery)/i.test(
      msg
    )
  );
}

const CONNECT_ATTEMPTS = 3;

/**
 * Takes a client, riding out a brief outage rather than turning it into a 500.
 *
 * Only connecting is retried, never a query. Once a caller's work has begun,
 * repeating it could double an insert or re-send a message, so a failure from
 * that point on is passed straight up. Acquiring a connection has no such
 * hazard: if it throws, by definition nothing ran.
 *
 * Three attempts over roughly a second and a half. That is sized for a pooler
 * restart or a dropped socket — not for a real outage, which should still fail
 * quickly and visibly instead of leaving pages hanging for a minute.
 */
/**
 * How long to keep using the fallback once it has worked.
 *
 * Without this, every request would re-test a pooler that is down and pay the
 * full retry budget before falling back — turning a working site into a slow
 * one for the whole outage. Two minutes is short enough to return to the
 * primary promptly once it recovers, and long enough that a multi-hour outage
 * costs the retry once per two minutes rather than once per request.
 */
const FALLBACK_STICKY_MS = 120_000;

async function tryConnect(pool: Pool, attempts: number): Promise<PoolClient> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await pool.connect();
    } catch (e) {
      last = e;
      if (!isTransientConnectionError(e) || attempt === attempts) break;
      // 150ms, then 600ms — long enough for a pooler to come back, short enough
      // that a page still renders inside a normal request budget.
      await new Promise((r) => setTimeout(r, 150 * 4 ** (attempt - 1)));
      console.warn(`[pg] connect retry ${attempt + 1}/${attempts}: ${(e as Error).message}`);
    }
  }
  throw last;
}

/**
 * Takes a client, riding out a brief outage rather than turning it into a 500.
 *
 * Only connecting is retried, never a query. Once a caller's work has begun,
 * repeating it could double an insert or re-send a message, so a failure from
 * that point on is passed straight up. Acquiring a connection has no such
 * hazard: if it throws, by definition nothing ran.
 *
 * Three attempts over roughly a second and a half, then — if there is one — the
 * direct route that skips the pooler entirely. That second half exists because
 * the failure this was written for lasted hours, not seconds, and no retry
 * budget large enough to cover it would be one a page could wait on.
 */
async function connectWithRetry(): Promise<PoolClient> {
  const fallback = getFallbackPool();
  const preferFallback = !!globalThis.__cosFallbackUntil && Date.now() < globalThis.__cosFallbackUntil;

  if (fallback && preferFallback) {
    try {
      return await tryConnect(fallback, 1);
    } catch {
      // The fallback has stopped working too; fall through and re-test the
      // primary, which may well have recovered in the meantime.
      globalThis.__cosFallbackUntil = undefined;
    }
  }

  try {
    const c = await tryConnect(getPool(), CONNECT_ATTEMPTS);
    // Primary is healthy again — stop preferring the fallback.
    globalThis.__cosFallbackUntil = undefined;
    return c;
  } catch (e) {
    if (!fallback || !isTransientConnectionError(e)) throw e;
    const client = await tryConnect(fallback, 2).catch(() => null);
    if (!client) throw e; // Report the primary's failure; it is the real one.
    if (!preferFallback) {
      console.warn("[pg] primary unreachable — serving via the direct connection");
    }
    globalThis.__cosFallbackUntil = Date.now() + FALLBACK_STICKY_MS;
    return client;
  }
}

/**
 * Connect exactly as a real request would, for the liveness probe.
 *
 * It has to be the same path, including the fallback: a probe that only tried
 * the pooler would report the platform down while the direct route was quietly
 * serving every page — the one moment the alert must not fire.
 */
export function connectAsRequest(): Promise<PoolClient> {
  return connectWithRetry();
}

/** Which route is currently serving, for the health endpoint to report. */
export function activeRoute(): "primary" | "fallback" {
  return globalThis.__cosFallbackUntil && Date.now() < globalThis.__cosFallbackUntil
    ? "fallback"
    : "primary";
}

/**
 * Inlines a value into SQL text. Only safe because every caller passes an
 * identifier the app itself produced — a uuid, a role name, a hex digest. The
 * character whitelist is the guarantee: anything else throws rather than
 * reaching the database, so a new caller cannot quietly widen this.
 *
 * Inlining exists to save a network round trip. Parameters force the extended
 * query protocol, which refuses multi-statement queries, so `begin` and the
 * context setup could not otherwise travel together.
 */
function safeLiteral(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`unsafe SQL literal: ${JSON.stringify(value.slice(0, 40))}`);
  }
  return `'${value}'`;
}

/** `begin` plus the four RLS settings, as one statement batch. */
function beginWithCtx(ctx: DbCtx): string {
  return (
    `begin; select set_config('app.user_id', ${safeLiteral(ctx.userId ?? "")}, true),` +
    ` set_config('app.clinic_id', ${safeLiteral(ctx.clinicId ?? "")}, true),` +
    ` set_config('app.role', ${safeLiteral(ctx.role ?? "")}, true),` +
    ` set_config('app.is_admin', '${ctx.isAdmin ? "true" : "false"}', true)`
  );
}

/**
 * Runs `fn` inside a transaction with RLS context applied via set_config.
 * All tenant-scoped access must go through this.
 */
export async function withCtx<T>(ctx: DbCtx, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectWithRetry();
  try {
    await client.query(beginWithCtx(ctx));
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * A single read, start to finish, in one round trip: transaction, RLS context,
 * query and commit are sent together and answered together.
 *
 * The saving is real — four round trips become one — but the price is that
 * `sql` cannot carry parameters, so every value in it must already have gone
 * through `safeLiteral`. Reach for `withCtx` unless a query is both read-only
 * and on a path that runs on every single page view.
 */
export async function readOneShot<T = Record<string, unknown>>(
  ctx: DbCtx,
  sql: string
): Promise<T[]> {
  const client = await connectWithRetry();
  try {
    const results = await client.query(`${beginWithCtx(ctx)}; ${sql}; commit`);
    // Statement order is begin, set_config, the caller's query, commit.
    const batch = results as unknown as { rows: T[] }[];
    if (!Array.isArray(batch) || batch.length !== 4) {
      throw new Error(`readOneShot expected 4 results, got ${(batch as unknown[])?.length}`);
    }
    return batch[2].rows;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export { safeLiteral };

/** System context: bypasses tenant scoping via the app.is_admin RLS clause. */
export function withSystem<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withCtx({ isAdmin: true }, fn);
}

export async function notifyClinic(c: PoolClient, clinicId: string, table: string) {
  await c.query("select pg_notify('app_events', $1)", [
    JSON.stringify({ t: table, op: "update", clinic_id: clinicId }),
  ]);
}
