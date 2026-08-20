import { timingSafeEqual } from "node:crypto";

/**
 * The shared secret between the web app and the worker.
 *
 * It does more than its name suggests, which is why it gets its own file. It
 * authorises the worker's control API — connect and disconnect any clinic's
 * WhatsApp number, and render any URL with a real browser — and it is the HMAC
 * key behind `/doc-print`, so knowing it is enough to mint a link to any signed
 * medical document by id. The worker answers on a public Railway domain, so
 * "internal" describes the intent, not the network.
 *
 * It used to fall back to a literal in the source when the variable was unset.
 * That fallback is the failure mode worth designing against: it is silent, it
 * looks like it is working, and the string is in a public-shaped repo. A
 * missing secret now fails the request it was needed for, and says why.
 */

const PLACEHOLDER = "dev-internal-secret-change-in-production";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** True when the configured value is missing or is the development placeholder. */
export function internalSecretIsWeak(): boolean {
  const raw = process.env.INTERNAL_API_SECRET;
  return !raw || raw === PLACEHOLDER || raw.length < 24;
}

/**
 * The secret, or a throw.
 *
 * Read on every call rather than captured at module load — the worker sets its
 * environment from `worker/env.ts` after imports have already run, and a value
 * frozen at import time there would be the old bug in a new place.
 */
export function internalSecret(): string {
  const raw = process.env.INTERNAL_API_SECRET;
  if (isProduction() && internalSecretIsWeak()) {
    throw new Error(
      "INTERNAL_API_SECRET is unset, too short, or still the development placeholder. " +
        "It authorises the worker control API and signs document print links, so it must be " +
        "a unique high-entropy value in production. Generate one with: openssl rand -hex 32"
    );
  }
  return raw || PLACEHOLDER;
}

/**
 * Compares a presented secret against the configured one in constant time.
 *
 * The timing channel on an HMAC-length string over the public internet is not
 * the realistic attack here; the reason to use it anyway is that `!==` on a
 * credential is the kind of line that gets copied into somewhere it does matter.
 */
export function internalSecretMatches(presented: string | string[] | undefined): boolean {
  if (typeof presented !== "string" || !presented) return false;
  let expected: string;
  try {
    expected = internalSecret();
  } catch {
    // Misconfigured in production: refuse everything rather than accept the
    // placeholder that half the internet can read in this file.
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
