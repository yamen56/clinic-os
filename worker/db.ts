import { Pool, type PoolClient } from "pg";

/**
 * Worker DB access. Connects as the app role but runs in the audited system
 * context (app.is_admin) — the worker is a trusted internal service that
 * spans all clinics.
 */
const url =
  process.env.DATABASE_URL || "postgres://clinicos_app:clinicos_app@127.0.0.1:5544/clinicos";

/**
 * TLS for hosted Postgres, but not for the local embedded server — nor for a
 * database on the provider's private network, which presents none. Asking for
 * SSL where it is not offered fails the connection rather than falling back.
 * Kept in step with `sslFor` in src/lib/db.ts.
 */
const noTls = /@(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.railway\.internal|[a-z0-9-]+\.internal)[:/]/i.test(
  url
);

export const pool = new Pool({
  connectionString: url,
  ssl: noTls ? undefined : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 8),
});
pool.on("error", (e) => console.error("[worker pg]", e.message));

export async function withSystem<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.is_admin', 'true', true)");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    try {
      await c.query("rollback");
    } catch {}
    throw e;
  } finally {
    c.release();
  }
}
