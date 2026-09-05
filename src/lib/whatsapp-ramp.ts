/**
 * How much a WhatsApp number is allowed to send while it is still new.
 *
 * The rails already in place shape *how* messages leave: randomised 3–10s gaps,
 * a daily cap, the blast guard, auto-pause after repeated errors. Not one of
 * them cares how old the number is — and age is the strongest single predictor
 * of whether a number survives, because bulk sending from a freshly registered
 * one is the pattern WhatsApp bans for. A clinic could scan a QR on a brand-new
 * SIM and reach three hundred messages the same afternoon.
 *
 * So the effective cap for the first stretch is the lower of what the clinic is
 * configured for and what the number has earned by existing.
 */

/** Where the ramp starts, on the number's first day. */
const DAY_ONE = 20;

/**
 * How fast it opens up: about a third more each day.
 *
 * 20, 27, 36, 49, 66, 89, 121, 163, 220, 297 — so a typical 300/day clinic is
 * unrestricted inside a fortnight, and the busiest early days are the ones held
 * back hardest. Growth rather than a fixed table because the shape is the point
 * and a table invites somebody to "just bump day one".
 */
const GROWTH = 1.35;

/** Past this, the ramp is never the binding constraint; stop computing it. */
const FULL_AFTER_DAYS = 21;

/**
 * The cap this number may send under today.
 *
 * `configured` is the clinic's own `daily_outbound_cap`; the ramp can only ever
 * lower it, never raise it. A null anchor means the ramp is not being tracked
 * for this session — treat it as warm rather than as brand new, because
 * guessing "new" would throttle an established clinic on the strength of a
 * missing column.
 */
export function effectiveDailyCap(configured: number, warmupStartedAt: Date | string | null): number {
  const ramp = rampCap(warmupStartedAt);
  return ramp === null ? configured : Math.min(configured, ramp);
}

/** The ramp's own ceiling, or null once the number is fully warm. */
export function rampCap(warmupStartedAt: Date | string | null): number | null {
  if (!warmupStartedAt) return null;
  const started = new Date(warmupStartedAt).getTime();
  if (!Number.isFinite(started)) return null;
  const days = Math.floor((Date.now() - started) / 86_400_000);
  if (days >= FULL_AFTER_DAYS) return null;
  // A clock skew or a future timestamp must not produce a cap above day one.
  const safeDays = Math.max(0, days);
  return Math.round(DAY_ONE * GROWTH ** safeDays);
}

/** How many days into the ramp this number is, for display. */
export function warmupDay(warmupStartedAt: Date | string | null): number | null {
  if (!warmupStartedAt) return null;
  const started = new Date(warmupStartedAt).getTime();
  if (!Number.isFinite(started)) return null;
  const days = Math.floor((Date.now() - started) / 86_400_000);
  return days >= FULL_AFTER_DAYS ? null : Math.max(0, days) + 1;
}
