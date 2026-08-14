/**
 * What somebody may do inside the agency panel.
 *
 * `users.is_super_admin` is the door: it decides whether /admin opens at all.
 * This decides what is behind it, so that the agency can hire a support person
 * without also handing them the ability to delete a customer, or a salesperson
 * without handing them every clinic's inbox.
 *
 * Deliberately the same shape as `lib/permissions` — `{level, caps}`, a `full`
 * that means "and anything added later", a resolver that denies on malformed
 * input. Two permission models in one codebase is already one more than ideal;
 * two permission models that disagree about what a stored row means would be
 * the kind of thing that produces a quiet privilege escalation.
 */

export const ADMIN_CAPABILITIES = [
  "analytics",
  "monitoring",
  "clinics.create",
  "clinics.edit",
  "clinics.features",
  "clinics.impersonate",
  "clinics.delete",
  "documents",
  "announcements",
  "defaults",
  "admins",
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];
export type AdminCapabilityMap = Record<AdminCapability, boolean>;

export type AdminAccessSetting = {
  level: "full" | "custom";
  caps: Partial<Record<AdminCapability, boolean>>;
};

/**
 * The clinic list itself is not a capability.
 *
 * Every agency admin can see which clinics exist and open one — an admin panel
 * whose front page is empty is not a limited admin, it is a broken login. What
 * varies is what you can *do* from there.
 */

/**
 * Presets, as starting points for the access editor. Picking one ticks its
 * boxes; every box stays editable afterwards, so these are suggestions rather
 * than roles — a role type would have to be stored, migrated and kept in step
 * with the capability list, and it would still be wrong for the third person
 * hired.
 */
export const ADMIN_PRESETS: { key: string; caps: AdminCapability[] }[] = [
  {
    // Answers the phone. Needs to get into a workspace and see why something
    // broke; must not be able to change what anyone is paying or delete them.
    key: "support",
    caps: ["monitoring", "clinics.impersonate", "analytics"],
  },
  {
    // Signs clinics up and sets what they bought. No reason to read a patient's
    // inbox, so no impersonation.
    key: "sales",
    caps: ["clinics.create", "clinics.edit", "clinics.features", "analytics"],
  },
  {
    // Writes the consent library, the announcements and the seeded defaults.
    key: "content",
    caps: ["documents", "announcements", "defaults"],
  },
];

/** Grouping for the editor, so related switches sit together. */
export const ADMIN_CAPABILITY_GROUPS: { key: string; caps: AdminCapability[] }[] = [
  { key: "clinics", caps: ["clinics.create", "clinics.edit", "clinics.features", "clinics.impersonate", "clinics.delete"] },
  { key: "insight", caps: ["analytics", "monitoring"] },
  { key: "content", caps: ["documents", "announcements", "defaults"] },
  { key: "agency", caps: ["admins"] },
];

function empty(): AdminCapabilityMap {
  return Object.fromEntries(ADMIN_CAPABILITIES.map((c) => [c, false])) as AdminCapabilityMap;
}

export function allAdminCapabilities(): AdminCapabilityMap {
  return Object.fromEntries(ADMIN_CAPABILITIES.map((c) => [c, true])) as AdminCapabilityMap;
}

export function adminCapabilitiesFor(list: AdminCapability[]): AdminCapabilityMap {
  const m = empty();
  for (const c of list) m[c] = true;
  return m;
}

/**
 * Reads `users.admin_permissions`.
 *
 * `isSuperAdmin` is checked first and returns nothing at all when false, so a
 * hand-written `admin_permissions` on an ordinary user grants exactly zero —
 * the column is a refinement of the flag, never a substitute for it.
 *
 * A row with no level is full, unlike the clinic-member resolver, which treats
 * the same absence as "job defaults". The asymmetry is intentional and is about
 * what the absence *means* in each table: a member row has always carried some
 * permissions shape, so a missing level there is an old row to interpret; this
 * column did not exist until now, so a missing level here is somebody who has
 * had unrestricted access since before the question was asked.
 */
export function resolveAdminCapabilities(
  raw: Record<string, unknown> | null | undefined,
  opts: { isSuperAdmin: boolean }
): AdminCapabilityMap {
  if (!opts.isSuperAdmin) return empty();
  const stored = (raw ?? {}) as Partial<AdminAccessSetting> & Record<string, unknown>;
  if (stored.level !== "custom") return allAdminCapabilities();

  const caps = empty();
  const ticked = (stored.caps ?? {}) as Record<string, unknown>;
  for (const c of ADMIN_CAPABILITIES) if (ticked[c] === true) caps[c] = true;
  return caps;
}

export function toAdminAccessSetting(
  level: "full" | "custom",
  caps: AdminCapabilityMap
): AdminAccessSetting {
  if (level === "full") return { level: "full", caps: {} };
  const out: Partial<Record<AdminCapability, boolean>> = {};
  for (const c of ADMIN_CAPABILITIES) out[c] = caps[c] === true;
  return { level: "custom", caps: out };
}

/** The level to show in the editor. Only an explicit `custom` is limited. */
export function adminLevelOf(raw: Record<string, unknown> | null | undefined): "full" | "custom" {
  return (raw as { level?: string } | null)?.level === "custom" ? "custom" : "full";
}
