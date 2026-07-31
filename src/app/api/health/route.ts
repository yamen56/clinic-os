import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/**
 * Whether the platform is actually working, for an uptime monitor to poll.
 *
 * This exists because of how the last two outages were discovered: by loading
 * the site and finding it broken. There was no way to be told. A monitor
 * hitting this every minute turns "a clinic phones to say the system is down"
 * into a notification that arrives first.
 *
 * Two things are checked, because they fail independently and both are
 * invisible from outside:
 *
 *   database — the pooler has twice lost its route to a healthy Postgres. The
 *     web app cannot serve a single signed-in page without it.
 *   worker   — no HTTP surface of its own, so nothing else can see it. If it
 *     dies, reminders stop going out, documents never render to PDF and
 *     WhatsApp goes quiet, all while the site looks perfectly fine.
 *
 * Deliberately unauthenticated, so a monitor can reach it without holding a
 * credential — and deliberately free of anything worth reading: no counts, no
 * names, no hostnames, no versions. Just whether it works, and how slowly.
 *
 * It does not go through `withCtx`: this is a liveness probe, so it wants the
 * unretried truth about right now rather than the resilience the app applies to
 * real traffic.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** A stuck check is a failed check — a probe must never hang the monitor. */
const TIMEOUT_MS = 5000;

/** Nothing to do for minutes at a time is normal; half an hour of silence is not. */
const WORKER_SILENT_AFTER_MS = 30 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export async function GET() {
  const started = Date.now();
  let dbOk = false;
  let dbMs: number | null = null;
  let dbError: string | null = null;
  let workerOk: boolean | null = null;
  let workerIdleMs: number | null = null;

  const client = await withTimeout(getPool().connect(), TIMEOUT_MS).catch((e: Error) => {
    dbError = e.message.slice(0, 120);
    return null;
  });

  if (client) {
    try {
      const t0 = Date.now();
      /*
        The worker's heartbeat is the most recent job it finished. Reading it in
        the same round trip as the liveness check keeps this endpoint to one
        query, which matters when a monitor calls it every minute forever.
      */
      const r = await withTimeout(
        client.query(
          `select 1 as up,
                  extract(epoch from (now() - max(updated_at))) * 1000 as idle_ms
             from jobs where status in ('done', 'failed')`
        ),
        TIMEOUT_MS
      );
      dbMs = Date.now() - t0;
      dbOk = true;

      const idle = r.rows[0]?.idle_ms;
      if (idle !== null && idle !== undefined) {
        workerIdleMs = Math.round(Number(idle));
        workerOk = workerIdleMs < WORKER_SILENT_AFTER_MS;
      } else {
        // No job has ever run. A fresh deployment, not a broken worker.
        workerOk = null;
      }
    } catch (e) {
      dbError = (e as Error).message.slice(0, 120);
    } finally {
      client.release();
    }
  }

  // The worker being quiet does not stop anyone using the platform, so it is
  // reported but does not by itself make this a failure.
  const ok = dbOk;

  return NextResponse.json(
    {
      ok,
      db: { ok: dbOk, ms: dbMs, ...(dbError ? { error: dbError } : {}) },
      worker: { ok: workerOk, idleMs: workerIdleMs },
      ms: Date.now() - started,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    }
  );
}
