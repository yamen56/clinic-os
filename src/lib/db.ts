import { Pool, type PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __cosPool: Pool | undefined;
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

export function getPool(): Pool {
  if (!globalThis.__cosPool) {
    const url =
      process.env.DATABASE_URL ||
      "postgres://clinicos_app:clinicos_app@127.0.0.1:5544/clinicos";
    globalThis.__cosPool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: Number(process.env.PG_POOL_MAX || 12),
      // A remote database makes a new connection expensive — TCP, TLS, then
      // auth before the first query. Hold idle ones long enough to span the
      // gaps between page views instead of paying that on every navigation.
      idleTimeoutMillis: 60_000,
      keepAlive: true,
      application_name: "clinicos-web",
    });
    globalThis.__cosPool.on("error", (e) => console.error("[pg pool]", e.message));
  }
  return globalThis.__cosPool;
}

export type DbCtx = {
  userId?: string | null;
  clinicId?: string | null;
  role?: string | null;
  isAdmin?: boolean;
};

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
  const client = await getPool().connect();
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
  const client = await getPool().connect();
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
