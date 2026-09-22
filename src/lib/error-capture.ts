import { createHash } from "node:crypto";
import { withSystem } from "@/lib/db";

/**
 * Recording that something threw, so it is found before a clinic reports it.
 *
 * See migrations/0057 for why this exists at all. The short version: every
 * other alarm here watches infrastructure, nothing watched the application, and
 * a 500 on one screen for one clinic was invisible from inside the building.
 */

export type ErrorKind = "server" | "action" | "route-handler" | "client";

export type ErrorContext = {
  route?: string | null;
  kind?: ErrorKind;
  clinicId?: string | null;
  userId?: string | null;
  digest?: string | null;
};

/**
 * Identifiers, stripped out before grouping.
 *
 * "patient 9f3a…-… not found" and the same sentence about a different patient
 * are one bug. Left alone they would be one row each, the count would never
 * rise above 1, and the table would grow with the size of the outage instead of
 * with the number of faults.
 */
function normalizeMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/\+\d{7,15}\b/g, "<phone>")
    .slice(0, 500);
}

/** The first frame that belongs to us, which is where the fault actually is. */
function topFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n").slice(1)) {
    const t = line.trim();
    if (!t.startsWith("at ")) continue;
    // node internals and dependencies are where it surfaced, not where it broke
    if (/node:internal|[\\/]node_modules[\\/]/.test(t)) continue;
    return t.replace(/:\d+:\d+\)?$/, "").slice(0, 200);
  }
  return stack.split("\n")[1]?.trim().slice(0, 200) ?? "";
}

function fingerprintOf(message: string, stack: string | undefined, route: string | null): string {
  return createHash("sha256")
    .update(`${normalizeMessage(message)}|${topFrame(stack)}|${route ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * How many errors this process will write in a minute before it stops.
 *
 * The failure being guarded against is specific and nasty. When the database
 * goes away, every request in flight throws — and if each of those throws tries
 * to write a row to that same database, the recording amplifies the outage it
 * exists to report, taking a pool connection per attempt at the moment
 * connections are the scarce thing.
 *
 * Thirty is plenty: the rows are grouped, so an outage is a handful of
 * fingerprints however many requests hit it, and the thirty-first occurrence of
 * the same fault in the same minute tells nobody anything the first did not.
 */
const MAX_WRITES_PER_MINUTE = 30;
let windowStart = 0;
let writesThisWindow = 0;

/**
 * Faults from the recording path itself, which must never be recorded.
 *
 * Writing "could not reach the database" into the database is a loop, and a
 * loop here runs during an outage.
 */
function isSelfInflicted(message: string): boolean {
  return /rate_counters|app_errors|\[error-capture\]/.test(message);
}

/**
 * Records one error. Never throws, never blocks the response on anything.
 *
 * Callers are not expected to await this — the request should finish whether or
 * not the bookkeeping did — but it is awaitable for the tests.
 */
export async function captureError(err: unknown, ctx: ErrorContext = {}): Promise<void> {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const message = (e.message || String(err) || "unknown error").slice(0, 2000);
    if (isSelfInflicted(message)) return;

    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      writesThisWindow = 0;
    }
    if (writesThisWindow >= MAX_WRITES_PER_MINUTE) return;
    writesThisWindow++;

    const route = ctx.route ?? null;
    const fingerprint = fingerprintOf(message, e.stack, route);

    await withSystem(async (c) => {
      await c.query(
        `insert into app_errors
           (fingerprint, message, stack, route, kind, last_clinic_id, last_user_id, last_digest)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (fingerprint) do update set
           count = app_errors.count + 1,
           last_seen = now(),
           -- The newest occurrence wins the details: when chasing a fault the
           -- useful question is who hit it last, not who hit it first.
           last_clinic_id = coalesce(excluded.last_clinic_id, app_errors.last_clinic_id),
           last_user_id = coalesce(excluded.last_user_id, app_errors.last_user_id),
           last_digest = coalesce(excluded.last_digest, app_errors.last_digest),
           stack = coalesce(excluded.stack, app_errors.stack),
           /*
             A fault that comes back after somebody marked it dealt with is open
             again — and is more interesting than it was the first time, because
             the fix did not hold.
           */
           resolved_at = null`,
        [
          fingerprint,
          message,
          e.stack?.slice(0, 8000) ?? null,
          route,
          ctx.kind ?? "server",
          ctx.clinicId ?? null,
          ctx.userId ?? null,
          ctx.digest ?? null,
        ]
      );
    });
  } catch (inner) {
    // Recording must never be the reason a request fails, and this is the one
    // place a console line is the whole story.
    console.error("[error-capture] could not record:", (inner as Error)?.message);
  }
}

/** Test seam, so a suite can assert the cap rather than infer it. */
export function resetCaptureThrottle() {
  windowStart = 0;
  writesThisWindow = 0;
}
