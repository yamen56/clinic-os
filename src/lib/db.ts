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
 * Runs `fn` inside a transaction with RLS context applied via set_config.
 * All tenant-scoped access must go through this.
 */
export async function withCtx<T>(ctx: DbCtx, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.user_id', $1, true),
              set_config('app.clinic_id', $2, true),
              set_config('app.role', $3, true),
              set_config('app.is_admin', $4, true)`,
      [ctx.userId ?? "", ctx.clinicId ?? "", ctx.role ?? "", ctx.isAdmin ? "true" : "false"]
    );
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

/** System context: bypasses tenant scoping via the app.is_admin RLS clause. */
export function withSystem<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withCtx({ isAdmin: true }, fn);
}

export async function notifyClinic(c: PoolClient, clinicId: string, table: string) {
  await c.query("select pg_notify('app_events', $1)", [
    JSON.stringify({ t: table, op: "update", clinic_id: clinicId }),
  ]);
}
