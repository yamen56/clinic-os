import { CAPABILITIES, type Capability, type CapabilityMap } from "./permissions";

/**
 * What a clinic is licensed for.
 *
 * A second gate above `lib/permissions`, and the distinction between the two is
 * worth being exact about, because they look similar and answer different
 * questions:
 *
 *   capabilities — what this *member of staff* may reach inside their clinic.
 *                  The clinic's owner decides them, and an owner always has all
 *                  of them.
 *   features     — what this *clinic* bought. The agency decides them, and the
 *                  owner cannot grant themselves one.
 *
 * They meet in exactly one place: `resolveCapabilities` is masked by the
 * clinic's features when a session is built, so a module the clinic does not
 * have is false in `caps` for everybody including the owner. That is the whole
 * enforcement story — the nav renders from `caps`, `guardCap` reads `caps`, and
 * every server action reads `caps` through `can()`. Nothing had to be taught
 * about features individually, which is the point: a gate that has to be
 * remembered in eighty call sites is a gate with holes in it.
 */

export const FEATURES = [
  "conversations",
  "calendar",
  "patients",
  "documents",
  "invoices",
  "campaigns",
  "automations",
  "ai",
] as const;

export type Feature = (typeof FEATURES)[number];
export type FeatureMap = Record<Feature, boolean>;

/**
 * The capabilities each module owns.
 *
 * `settings` is deliberately absent: a clinic that cannot open its own settings
 * cannot set its working hours, its branding or its staff, and would have to
 * ring the agency to change a phone number. It is not a module anybody sells.
 */
const FEATURE_CAPS: Record<Feature, Capability[]> = {
  conversations: ["conversations"],
  calendar: ["calendar"],
  patients: ["patients"],
  documents: ["documents", "documents.manage", "documents.void"],
  invoices: ["invoices"],
  campaigns: ["campaigns"],
  automations: ["automations"],
  ai: ["ai"],
};

export function allFeatures(): FeatureMap {
  return Object.fromEntries(FEATURES.map((f) => [f, true])) as FeatureMap;
}

/**
 * Reads `clinics.features` into a complete map.
 *
 * A missing key is **on**. The column was added to a database full of clinics
 * that had bought the whole product, and the alternative — treating `{}` as
 * nothing licensed — would have switched off every workspace on the platform at
 * the moment of the migration. It also means a feature added next year is on
 * for everybody until somebody decides otherwise, which is the right default
 * for a thing the customer is already paying for.
 */
export function resolveFeatures(raw: Record<string, unknown> | null | undefined): FeatureMap {
  const stored = raw ?? {};
  return Object.fromEntries(FEATURES.map((f) => [f, stored[f] !== false])) as FeatureMap;
}

/** Serialises the admin editor's state back into the column. */
export function toFeatureSetting(map: FeatureMap): Record<Feature, boolean> {
  return Object.fromEntries(FEATURES.map((f) => [f, map[f] === true])) as Record<Feature, boolean>;
}

/**
 * Capabilities, minus anything the clinic is not licensed for.
 *
 * Applied after `resolveCapabilities`, never before: a member's stored
 * permissions are theirs and should survive a module being switched off and
 * back on. Masking at read time means restoring the feature restores exactly
 * the access people had, with nothing to re-tick.
 */
export function maskByFeatures(caps: CapabilityMap, features: FeatureMap): CapabilityMap {
  const denied = new Set<Capability>();
  for (const f of FEATURES) {
    if (!features[f]) for (const cap of FEATURE_CAPS[f]) denied.add(cap);
  }
  if (denied.size === 0) return caps;
  const out = { ...caps };
  for (const cap of CAPABILITIES) if (denied.has(cap)) out[cap] = false;
  return out;
}

/** Count of modules a clinic has, for the "6 of 8" summary on the admin list. */
export function enabledFeatureCount(features: FeatureMap): number {
  return FEATURES.filter((f) => features[f]).length;
}
