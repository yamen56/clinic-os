import { createHmac, timingSafeEqual } from "node:crypto";
import { internalSecret } from "./internal-secret";

/**
 * A short-lived key that lets the worker's Chromium open one print page without
 * a session.
 *
 * The renderer runs in the worker, which has no cookie and no user. The invoice
 * PDF solves this with the invoice's permanent public token, which is right for
 * something the patient is meant to open forever. A consent form and a patient
 * record are not that: nothing about either should be reachable by URL once the
 * render has finished. So the key is derived rather than stored — an HMAC over
 * the subject and an expiry, good for minutes.
 *
 * The signing module had this first, for documents. It lives here now because a
 * patient record needs exactly the same thing, and one HMAC that two callers
 * share is safer than two that drift. The signed string is unchanged, so keys
 * minted before this move still verify.
 */

const TTL_MS = 5 * 60_000;

function sign(subject: string, kind: string, exp: number): string {
  return createHmac("sha256", internalSecret()).update(`${subject}:${kind}:${exp}`).digest("base64url");
}

export function printKeyFor(subject: string, kind: string): { exp: number; sig: string } {
  const exp = Date.now() + TTL_MS;
  return { exp, sig: sign(subject, kind, exp) };
}

/**
 * `kinds` is the caller's own allowlist.
 *
 * A kind arrives from the query string and goes straight into the signed
 * string, so without this a caller could mint a key for one kind of page and
 * spend it on another. Each print page passes the kinds it is willing to serve.
 */
export function verifyPrintKeyFor(
  subject: string,
  kind: string,
  exp: string | undefined,
  sig: string | undefined,
  kinds: readonly string[]
): boolean {
  if (!exp || !sig) return false;
  if (!kinds.includes(kind)) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = Buffer.from(sign(subject, kind, expNum));
  const given = Buffer.from(sig);
  // Compare only equal-length buffers; timingSafeEqual throws otherwise, and a
  // length mismatch is already a failure.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
