/**
 * Whether a value from a URL is shaped like one of our ids.
 *
 * Checked before it reaches a query. Postgres refuses a malformed uuid with an
 * error rather than an empty result, so `/patients/abc` — a truncated link from
 * a WhatsApp message, a typo, an old bookmark — was a crash screen and a 500 in
 * the error feed instead of "not found". Every one of those woke somebody up
 * for a URL that simply names nothing.
 *
 * Imports nothing, so pages, routes, the edge and the worker can all use it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}
