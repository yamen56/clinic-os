import { NextResponse } from "next/server";
import { activeRoute, connectAsRequest } from "@/lib/db";

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
 * It connects the same way a real request does — retries, and the direct-route
 * fallback included — because the question this answers is "can the platform
 * serve?", not "is one particular host up". A probe that only tried the pooler
 * would page someone at 3am while the fallback was quietly serving every page.
 * `route` says which way it got in.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** A stuck check is a failed check — a probe must never hang the monitor. */
const TIMEOUT_MS = 5000;

/**
 * How stale the worker's heartbeat may get before it counts as down.
 *
 * `worker_status.updated_at` is rewritten every 60 seconds by the process
 * itself (worker/status.ts), so five minutes is five missed beats — a restart
 * and a slow boot both fit comfortably inside it, and nothing healthy does not.
 */
const WORKER_SILENT_AFTER_MS = 5 * 60 * 1000;

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

  const client = await withTimeout(connectAsRequest(), TIMEOUT_MS).catch((e: Error) => {
    dbError = e.message.slice(0, 120);
    return null;
  });

  if (client) {
    try {
      const t0 = Date.now();
      /*
        The worker's own heartbeat, not its workload.

        This used to read the most recent finished job, and that is only a
        liveness signal on a platform busy enough to always have one. This one
        is not: real traffic is a few dozen jobs a *month*, so the query
        returned null and the endpoint reported `worker: {ok: null}` — which the
        code below reads, correctly, as "a fresh deployment". During the
        day-long crash loop on 2026-09-05 that was the answer the whole time,
        and it was indistinguishable from a healthy quiet worker.

        `worker_status.updated_at` is written every 60 seconds by the process
        itself and stops the instant it dies, whether or not it had anything to
        do. Still one round trip, which matters when a monitor calls this
        forever.
      */
      const r = await withTimeout(
        client.query(
          `select 1 as up,
                  extract(epoch from (now() - updated_at)) * 1000 as idle_ms
             from worker_status where id = true`
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
        // No row at all: this worker has never started since the table existed.
        // Unknown rather than false, so a brand-new environment does not page
        // somebody — but it is not `true` either.
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
      // "fallback" means the pooler is down and the direct route is carrying
      // the app — working, but worth knowing about rather than discovering later.
      route: activeRoute(),
      worker: { ok: workerOk, idleMs: workerIdleMs },
      ms: Date.now() - started,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    }
  );
}
