import { headers } from "next/headers";
import { withSystem } from "@/lib/db";

/**
 * How many failures, over what window, before a door stops opening.
 *
 * Two keys per attempt, deliberately:
 *
 *  - **ip** stops one machine working through a list of accounts. It is the
 *    strict one, because a person who has genuinely forgotten their password
 *    does not produce ten failures in a quarter of an hour.
 *  - **email** stops many machines working on one account, which is what
 *    credential stuffing looks like and what an IP limit cannot see.
 *
 * The email limit is the looser of the two on purpose. Any per-account lockout
 * can be turned around and used to lock a known user out deliberately, so the
 * threshold sits high enough that doing so takes sustained effort, while still
 * being far below what guessing a password requires. The alternative — no
 * account-level limit at all — leaves credential stuffing unanswered, which is
 * the more likely attack by a wide margin.
 */
const LIMITS: Record<string, { ip: [number, string]; email: [number, string] }> = {
  login: { ip: [10, "15 minutes"], email: [15, "15 minutes"] },
  // Resets send mail. The limit here is as much about not being used as a way
  // to flood somebody's inbox as it is about guessing.
  reset: { ip: [5, "1 hour"], email: [3, "1 hour"] },
};

export type AuthScope = keyof typeof LIMITS;

/**
 * The caller's address, from a server action rather than a Request.
 *
 * Same rule as `clientIp` in booking-public.ts and for the same reason: only
 * the rightmost entry of X-Forwarded-For was appended by our own proxy.
 * Everything to its left is whatever the client chose to send, so reading the
 * leftmost would let an attacker mint a fresh bucket per request and never be
 * limited at all.
 */
export async function actionIp(): Promise<string> {
  const h = await headers();
  const chain = h.get("x-forwarded-for");
  if (!chain) return h.get("x-real-ip")?.trim() || "local";
  const parts = chain.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

function keysFor(ip: string, email: string) {
  return { ip: `ip:${ip}`, email: `email:${email.toLowerCase()}` };
}

/** True when this attempt should be refused before any password is checked. */
export async function isThrottled(scope: AuthScope, ip: string, email: string): Promise<boolean> {
  const lim = LIMITS[scope];
  const k = keysFor(ip, email);
  return withSystem(async (c) => {
    /*
      One round trip, not two. node-pg serialises queries on a single client, so
      two counts would cost two sequential waits on the hot path of every
      sign-in — including every successful one.
    */
    const r = await c.query(
      `select
         count(*) filter (where key = $2 and created_at > now() - $4::interval) as ip_n,
         count(*) filter (where key = $3 and created_at > now() - $5::interval) as email_n
       from auth_attempts
       where scope = $1 and key in ($2, $3)`,
      [scope, k.ip, k.email, lim.ip[1], lim.email[1]]
    );
    const row = r.rows[0];
    return Number(row.ip_n) >= lim.ip[0] || Number(row.email_n) >= lim.email[0];
  });
}

/** Records one failure against both keys. */
export async function recordFailure(scope: AuthScope, ip: string, email: string): Promise<void> {
  const k = keysFor(ip, email);
  await withSystem(async (c) => {
    await c.query(
      `insert into auth_attempts (scope, key) values ($1, $2), ($1, $3)`,
      [scope, k.ip, k.email]
    );
    /*
      Pruned here rather than on a schedule: this runs only on failure, which is
      rare in normal use and bounded during an attack, because the throttle
      starts refusing before the row count can run away.
    */
    await c.query(`delete from auth_attempts where created_at < now() - interval '1 day'`);
  });
}

/**
 * Forgets the failures for an account that has just proved itself.
 *
 * Only the email key is cleared, never the address. Somebody who signs in
 * correctly on the twelfth try has demonstrated the account is theirs; an IP
 * that produced eleven failures across other people's accounts has demonstrated
 * the opposite, and one correct password should not wipe that.
 */
export async function clearFailures(scope: AuthScope, email: string): Promise<void> {
  await withSystem((c) =>
    c.query(`delete from auth_attempts where scope = $1 and key = $2`, [
      scope,
      `email:${email.toLowerCase()}`,
    ])
  );
}
