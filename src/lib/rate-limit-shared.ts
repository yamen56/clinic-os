import { withSystem } from "@/lib/db";

/**
 * A rate limit that counts once for the whole fleet, not once per process.
 *
 * `rateLimit` in booking-public.ts counts into a Map, which makes it a
 * per-instance floor: with N replicas the real allowance is N times the number
 * written at the call site. That is acceptable for a read endpoint — the point
 * there is shedding load, and a floor per instance still sheds it. It is not
 * acceptable for the two things this exists for:
 *
 *   - **A side effect.** `start-phone` decides how many one-time codes a phone
 *     number can be sent. Multiplying that by the replica count turns a limit
 *     into a way to text somebody repeatedly.
 *   - **A guess.** `verify` decides how many attempts somebody gets at a
 *     six-digit code. Multiplying that multiplies the attacker's odds directly.
 *
 * Use this wherever the number at the call site is a promise about the real
 * world. Use `rateLimit` where it is only about load.
 */

/**
 * How often an expired window is swept, as one call in this many.
 *
 * Pruning belongs somewhere, and the options are a scheduled job, every call,
 * or occasionally. Every call doubles the write cost of every limited request
 * for a table that is almost entirely dead rows. A scheduled job is one more
 * thing that can silently stop — the failure this codebase has already had with
 * the backup. Occasional keeps it in the same transaction as work that was
 * happening anyway, and the table is bounded either way: a row is two integers
 * and a key, and the limit starts refusing before the row count can run away.
 */
const PRUNE_ONE_IN = 100;

/**
 * True when this request should be served.
 *
 * Fails **open**, deliberately. If the database cannot be reached, then every
 * endpoint that calls this cannot do its work either — `start` cannot write a
 * verification row, `verify` cannot read one — so refusing here would swap one
 * error for a more confusing one rather than protect anything. The in-process
 * floor in front of these routes still applies, so "open" never means unlimited.
 */
export async function rateLimitShared(
  key: string,
  max: number,
  windowMs: number
): Promise<boolean> {
  /*
    The window start is part of the key rather than a column to compare against.
    Two replicas whose clocks differ by a second must agree on which window a
    request belongs to, and flooring a shared epoch is the only way they do —
    comparing each one's `now()` against a stored `expires_at` would let a
    request land in a window the other process considers finished.
  */
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const bucket = `${key}@${windowStart}`;
  // Twice the window, so a row is never pruned while its window is still live
  // even if a replica's clock is behind.
  const expiresAt = new Date(windowStart + windowMs * 2);

  try {
    return await withSystem(async (c) => {
      /*
        Increment and read in one statement. Two statements would be a
        read-then-write race between replicas — exactly the thing this file
        exists to close — and `on conflict do update` is atomic against the row
        even when several processes arrive together.
      */
      const r = await c.query(
        `insert into rate_counters (bucket, count, expires_at)
         values ($1, 1, $2)
         on conflict (bucket) do update set count = rate_counters.count + 1
         returning count`,
        [bucket, expiresAt]
      );
      const n = Number(r.rows[0].count);
      if (Math.random() < 1 / PRUNE_ONE_IN) {
        await c.query(`delete from rate_counters where expires_at < now()`);
      }
      return n <= max;
    });
  } catch (e) {
    console.error("[rate-limit-shared] counting failed, allowing:", (e as Error).message);
    return true;
  }
}
