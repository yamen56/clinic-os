/**
 * The coarse limit in front of everything with no session.
 *
 * The per-route counters guard the endpoints somebody thought to guard. This
 * guards the ones nobody did — the booking page itself, the invoice page, the
 * signing page, the login form — which render server-side and query the
 * database, and which had no limit of any kind on them.
 *
 * It runs in the middleware, so a refused request never reaches a route, never
 * takes a database connection, and never allocates anything but a counter.
 * That placement is the entire point: shedding load is only useful if it
 * happens before the expensive part, and by the time a route handler is running
 * the expensive part has already been scheduled.
 *
 * **Deliberately dependency-free.** The middleware runs in the Edge runtime,
 * which has no `pg` and no Node built-ins, so anything this file imported would
 * have to be edge-safe forever. It imports nothing, which makes that
 * impossible to get wrong — and lets the QA suite exercise the counting
 * directly, the way `qa-auth-throttle.ts` tests the auth throttle rather than
 * the login form.
 */

/**
 * Five requests a second, sustained, from one address.
 *
 * Sized to be unreachable by a person and uncomfortable for a script. A patient
 * booking an appointment makes perhaps thirty requests in a session; a whole
 * clinic sharing one office address is still nowhere near this, which matters
 * because the cost of a false positive here is a real patient seeing an error
 * on a real clinic's booking link.
 *
 * It is not sized to stop a botnet — nothing in this process can, and pretending
 * otherwise is worse than saying so. It stops one machine, which is the shape
 * of nearly every attempt an app this size actually sees.
 */
export const FLOOD_MAX = Number(process.env.FLOOD_MAX || 300);
export const FLOOD_WINDOW_MS = Number(process.env.FLOOD_WINDOW_MS || 60_000);

/** How many distinct addresses are tracked before the map is swept. */
const MAX_KEYS = 20_000;

type Window = { count: number; reset: number };
const seen = new Map<string, Window>();

/**
 * True when this request should be served.
 *
 * Fixed windows, not a sliding log. A sliding window is more accurate and
 * stores a timestamp per request, which hands the attacker a way to make us
 * allocate — the opposite of what a flood gate is for. A fixed window costs two
 * numbers per address no matter how hard it is hit.
 */
export function allow(key: string, now = Date.now()): boolean {
  if (seen.size > MAX_KEYS) {
    for (const [k, w] of seen) if (w.reset <= now) seen.delete(k);
    // Still full: every window is live, which means this is a distributed
    // flood. Drop the whole table rather than grow — the addresses being
    // forgotten are overwhelmingly single-request ones, and an unbounded map is
    // a slower version of the crash being prevented.
    if (seen.size > MAX_KEYS) seen.clear();
  }
  const w = seen.get(key);
  if (!w || w.reset <= now) {
    seen.set(key, { count: 1, reset: now + FLOOD_WINDOW_MS });
    return true;
  }
  w.count++;
  return w.count <= FLOOD_MAX;
}

/** Test seam. Never called by the app. */
export function resetFloodGate() {
  seen.clear();
}

/**
 * The caller's address, as our own proxy saw it, or null when nothing
 * identifies them.
 *
 * The rightmost entry of `X-Forwarded-For`, for the same reason as `clientIp`
 * in booking-public.ts: everything to its left is whatever the client typed, so
 * reading the leftmost lets an attacker mint a fresh bucket per request and
 * never be limited at all. That exact bug has been fixed in this codebase once
 * already; it is not being reintroduced in a new file.
 *
 * **Null rather than a shared bucket, and this is the important part.** Our
 * proxy always appends a forwarded address, so in production there is always a
 * key. If that ever stopped being true — a routing change, a direct-to-container
 * request, running the server without a proxy — then folding every caller into
 * one bucket named "local" would rate-limit *the entire internet as a single
 * visitor*, and the booking, signing and invoice links would go dark for
 * everybody at 300 requests a minute worldwide.
 *
 * That is a far worse outcome than the flood this file exists to stop, and it
 * would arrive silently, so an unidentifiable caller is not counted at all. The
 * per-endpoint limits in booking-public.ts still apply to them, and the
 * consequence there is one endpoint rather than every page.
 */
export function floodKey(xff: string | null, realIp: string | null): string | null {
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return realIp?.trim() || null;
}
