/**
 * What a member of staff may do.
 *
 * One list, in one file, so that a capability cannot exist on a screen and be
 * missing from the settings page that is supposed to control it. Every gate in
 * the app reads `caps` — no screen re-derives permission from a job title.
 *
 * Two levels:
 *
 *   full   — everything, including capabilities that do not exist yet. This is
 *            deliberate. An owner who granted full access should not have to
 *            revisit every member each time a feature ships.
 *   custom — only what is ticked.
 *
 * The clinic owner is always full, whatever is stored, and the settings screen
 * refuses to change that. A clinic that can lock itself out of its own account
 * is a support ticket, not a feature.
 */

export const CAPABILITIES = [
  "conversations",
  "calendar",
  "patients",
  "documents",
  "documents.manage",
  "documents.void",
  "invoices",
  "campaigns",
  "automations",
  "ai",
  "settings",
  "settings.clinic",
  "settings.staff",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityMap = Record<Capability, boolean>;

/** Job title. Decides scheduling, not access — only a doctor is bookable. */
export type MemberRole = "doctor" | "receptionist" | "other";

export type AccessSetting = {
  level: "full" | "custom";
  caps: Partial<Record<Capability, boolean>>;
};

/**
 * Capabilities that only make sense alongside another one. Hiding a section but
 * leaving its actions ticked would produce a member who may void a document they
 * cannot open, so the resolver closes that off rather than trusting the stored
 * map — the same rule then applies to a hand-edited row, not just to the UI.
 */
const REQUIRES: Partial<Record<Capability, Capability>> = {
  "documents.manage": "documents",
  "documents.void": "documents",
  "settings.clinic": "settings",
  "settings.staff": "settings",
};

/** The starting point when an owner switches a member to custom access. */
export const ROLE_DEFAULTS: Record<MemberRole, Capability[]> = {
  doctor: ["calendar", "patients", "documents"],
  receptionist: [
    "conversations",
    "calendar",
    "patients",
    "documents",
    "documents.manage",
    "invoices",
    "settings",
  ],
  other: ["calendar", "patients"],
};

function empty(): CapabilityMap {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, false])) as CapabilityMap;
}

export function allCapabilities(): CapabilityMap {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as CapabilityMap;
}

export function capabilitiesFor(list: Capability[]): CapabilityMap {
  const m = empty();
  for (const c of list) m[c] = true;
  return m;
}

/**
 * Reads whatever is in `clinic_members.permissions` and returns a complete map.
 *
 * It has to tolerate three shapes: the current one, the pre-0014 `{}` and
 * `{automations:true}`, and anything hand-edited since. Unknown keys are
 * ignored and missing ones are false, so a malformed row denies rather than
 * grants.
 */
export function resolveCapabilities(
  raw: Record<string, unknown> | null | undefined,
  opts: { isOwner: boolean; role: MemberRole }
): CapabilityMap {
  if (opts.isOwner) return allCapabilities();

  const stored = (raw ?? {}) as Partial<AccessSetting> & Record<string, unknown>;
  if (stored.level === "full") return allCapabilities();

  let caps: CapabilityMap;
  if (stored.level === "custom" && stored.caps && typeof stored.caps === "object") {
    const ticked = stored.caps as Record<string, unknown>;
    caps = empty();
    for (const c of CAPABILITIES) if (ticked[c] === true) caps[c] = true;
    /*
      `ai` was split out of `automations` after these rows were written, so a
      map saved before the split has no opinion about it — only a `true` under
      `automations`, which at the time meant both screens. Reading that silence
      as a denial would have taken the AI agent away from every member who had
      it, in every clinic, on deploy. An explicit false is still honoured; only
      the absence inherits.
    */
    if (!("ai" in ticked) && caps.automations) caps.ai = true;
  } else {
    /*
      No level recorded: a row written before this model existed, or one whose
      access has never been set. Fall back to what the job title implies, plus
      the one flag the old shape carried, so an un-migrated row still behaves.
    */
    caps = capabilitiesFor(ROLE_DEFAULTS[opts.role] ?? []);
    if (stored.automations === true) {
      caps.automations = true;
      caps.ai = true;
      caps.campaigns = true;
    }
  }

  for (const [cap, needs] of Object.entries(REQUIRES) as [Capability, Capability][]) {
    if (!caps[needs]) caps[cap] = false;
  }
  return caps;
}

/** Serialises the settings-screen state back into the column. */
export function toAccessSetting(level: "full" | "custom", caps: CapabilityMap): AccessSetting {
  if (level === "full") return { level: "full", caps: {} };
  const out: Partial<Record<Capability, boolean>> = {};
  for (const c of CAPABILITIES) out[c] = caps[c] === true;
  return { level: "custom", caps: out };
}

/**
 * The level to show on the settings screen.
 *
 * Only an explicit `full` counts as full. A row with no level — one written
 * before this model existed — resolves to its job's defaults, not to everything,
 * so reading it as "full" here would show the owner a screen claiming more
 * access than the member has and grant it for real on the next save.
 */
export function accessLevelOf(raw: Record<string, unknown> | null | undefined): "full" | "custom" {
  return (raw as { level?: string } | null)?.level === "full" ? "full" : "custom";
}

/** Grouping for the settings screen, so actions sit under the section they belong to. */
export const CAPABILITY_GROUPS: { section: Capability; actions: Capability[] }[] = [
  { section: "conversations", actions: [] },
  { section: "calendar", actions: [] },
  { section: "patients", actions: [] },
  { section: "documents", actions: ["documents.manage", "documents.void"] },
  { section: "invoices", actions: [] },
  { section: "campaigns", actions: [] },
  { section: "automations", actions: [] },
  { section: "ai", actions: [] },
  { section: "settings", actions: ["settings.clinic", "settings.staff"] },
];
