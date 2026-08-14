/**
 * The clinic's licence, as SQL the worker can join against.
 *
 * The web app enforces modules by masking capabilities on the session, which
 * closes every screen and every server action — but the worker has no session
 * and no screens. It reads rows and acts on them, so an automation that was
 * activated while the clinic still had the module would carry on firing after
 * the agency took it away, and the AI agent would carry on answering WhatsApp
 * and spending tokens nobody is being billed for. The commercially important
 * half of "switch this module off" happens here, not in the nav.
 *
 * Mirrors `resolveFeatures` in src/lib/features.ts, including the rule that
 * matters most: an absent key means enabled. Every clinic that predates the
 * column has `{}` and must keep working exactly as before.
 */

/** True while the clinic still has this module. Expects `clinics` aliased `cl`. */
export function hasFeature(feature: string, alias = "cl"): string {
  return `coalesce((${alias}.features->>'${feature}')::boolean, true)`;
}

/** The full predicate for "this clinic is live and licensed for X". */
export function licensed(feature: string, alias = "cl"): string {
  return `${alias}.deleted_at is null and ${hasFeature(feature, alias)}`;
}
