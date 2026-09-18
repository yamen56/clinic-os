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
  "dashboard",
  "conversations",
  "calendar",
  "patients",
  "patients.import",
  "patients.export",
  /*
    Who may change the note categories themselves — add one, or delete one.

    Carved out of `patients`, which is where it used to live: anyone who could
    open a patient file could invent a category, and deleting one was not
    possible at all. Both are edits to a vocabulary the whole clinic files
    against, not to one patient's record, so they belong to whoever decides how
    the clinic keeps its notes rather than to everyone who writes them.

    Silence in a stored map means no, the same reading `invoices.analytics` was
    changed to: a member granted Patients — to write notes, which is the job —
    should not also quietly be able to delete the category forty notes sit
    under. An owner ticks this for the person who curates the list.
  */
  "patients.categories",
  "documents",
  "documents.manage",
  "documents.void",
  "invoices",
  "invoices.analytics",
  /*
    A doctor's own earnings, and nobody else's.

    Top-level rather than `invoices.earnings`, which would have been the tidier
    name and does not work: a dotted capability needs a `REQUIRES` parent, the
    parent would be `invoices`, and a doctor does not have `invoices` — by
    design, and the resolver would strip this from the only role meant to hold
    it. The all-doctors payout report is a different screen gated on
    `invoices.analytics`; this one is strictly "mine".
  */
  "earnings",
  /*
    What the clinic spends, and what it therefore actually kept.

    Top-level for the same reason `earnings` is, and for one of its own: the
    person who does the buying is not necessarily the person who does the
    billing, so this has to be grantable without also handing over Invoices. It
    is emphatically not `invoices.expenses` — that would require `invoices`, and
    a receptionist granted the takings would silently also get the salary bill,
    which is the most sensitive number in the business.
  */
  "expenses",
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
  "patients.import": "patients",
  "patients.export": "patients",
  "patients.categories": "patients",
  "documents.manage": "documents",
  "documents.void": "documents",
  "invoices.analytics": "invoices",
  "settings.clinic": "settings",
  "settings.staff": "settings",
};

/** The starting point when an owner switches a member to custom access. */
export const ROLE_DEFAULTS: Record<MemberRole, Capability[]> = {
  // A doctor on a revenue share can see what they have earned, and nothing else
  // about the clinic's money. The screen is empty and harmless for a doctor who
  // has no arrangement, so it costs nothing to start on.
  doctor: ["dashboard", "calendar", "patients", "documents", "earnings"],
  receptionist: [
    "dashboard",
    "conversations",
    "calendar",
    "patients",
    // Bringing a list in is desk work. Taking the whole list out is not, and
    // stays off until an owner says otherwise — see the note on the resolver.
    "patients.import",
    "documents",
    "documents.manage",
    "invoices",
    /*
      `invoices.analytics` is deliberately *not* here any more.

      The desk takes the money, so it starts able to raise invoices, settle them
      and see what a patient owes — all of which it needs. What it no longer
      starts with is the clinic's own takings: the day's total, the week against
      last week, the sum outstanding. That is the owner's number, and "an owner
      who does not want that unticks one box" turned out to be the wrong default,
      because nobody unticks a box they never knew was ticked.

      Still grantable. An owner who wants their practice manager to see the
      takings ticks it, once, for that person.
    */
    "settings",
  ],
  other: ["dashboard", "calendar", "patients"],
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
  /*
    What the stored map has an opinion about. Empty for a row written before this
    model existed, which is the point: the inheritance rules below have to read
    that silence the same way whichever shape the row is in.
  */
  let ticked: Record<string, unknown> = {};
  if (stored.level === "custom" && stored.caps && typeof stored.caps === "object") {
    ticked = stored.caps as Record<string, unknown>;
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
    /*
      `invoices.analytics` used to inherit from `invoices` here, on the same
      reasoning as the `ai` rule above: the split came after these rows were
      written, so silence meant "they had it before".

      **Removed deliberately, and it is the one rule that has been reversed.**
      The inheritance was doing exactly what it was built to do and the effect
      was still wrong: a receptionist granted Invoices — to raise and settle
      them, which is the job — silently also received the clinic's takings.
      Nobody ticked it and so nobody thought to untick it, and a clinic found
      its staff looking at the week's revenue.

      An owner who wants somebody to see the takings ticks the box. Silence now
      means no, which is the answer that cannot surprise anyone.
    */
    /*
      `earnings` has no rule here, deliberately, and the absence is the decision.

      The three rules above all replace a capability that a *wider* grant used to
      imply, so silence inherits from that wider grant. `earnings` replaces
      nothing — before it there was no way for a doctor to see what they had
      earned, because there was nothing to earn. So a stored map that does not
      mention it is not ambiguous the way those were; it was written when the
      answer was no, and it stays no.

      That follows `patients.export` rather than `dashboard`, for the reason
      stated there: a capability that did not exist yesterday must never resolve
      to more access than the rule it replaced. A doctor on `full` picks it up
      automatically; one on a hand-ticked map needs an owner to tick it, which is
      the direction that cannot surprise anybody.
    */
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

  /*
    Import inherits from `patients`, because it was open to anyone with the
    section until it became a capability of its own — reading the silence as a
    denial would take it away from people who have it today.

    Outside the branch above, unlike the two rules in it, because a row with no
    `level` at all is the *older* shape and so the one most certain to predate
    the split. Inside the branch, a legacy doctor — whose job defaults grant
    Patients — would have quietly lost the importer.

    Export does **not** inherit, and the asymmetry is the whole point. It was
    restricted to the clinic owner, so treating silence as a grant would hand
    every member with Patients the ability to walk out with the entire database.
    A capability that did not exist yesterday must never resolve to more access
    than the rule it replaced.
  */
  if (!("patients.import" in ticked) && caps.patients) caps["patients.import"] = true;

  /*
    The dashboard inherits from nothing, and that is the difference between this
    rule and the three above it.

    Those replaced a capability that used to be implied by a *wider* one, so the
    silence inherits from that wider grant. The dashboard was implied by nothing
    at all — it was simply the screen every member of every clinic could open,
    and the guards deliberately sent people there when they hit something they
    could not. So a stored map that does not mention it is not ambiguous: it was
    written when the answer was unconditionally yes.

    An explicit false is honoured, which is the whole point of the feature. Only
    the absence grants.
  */
  if (!("dashboard" in ticked)) caps.dashboard = true;

  for (const [cap, needs] of Object.entries(REQUIRES) as [Capability, Capability][]) {
    if (!caps[needs]) caps[cap] = false;
  }
  return caps;
}

/**
 * Serialises the settings-screen state back into the column.
 *
 * Every capability is written, including the false ones. That is what lets the
 * resolver tell "this owner said no" apart from "this row predates the setting"
 * — the inheritance rules there read an absent key as a grant, so a row that
 * listed only the ticked boxes would quietly re-grant what an owner unticked.
 *
 * `REQUIRES` is applied here as well as on the way out. The resolver is the
 * enforcement — every read goes through it — but a row is also read by people,
 * in the audit trail and in support, and one that claims a member may void a
 * document they cannot open is a row that will eventually be believed.
 */
export function toAccessSetting(level: "full" | "custom", caps: CapabilityMap): AccessSetting {
  if (level === "full") return { level: "full", caps: {} };
  const out: Partial<Record<Capability, boolean>> = {};
  for (const c of CAPABILITIES) out[c] = caps[c] === true;
  for (const [cap, needs] of Object.entries(REQUIRES) as [Capability, Capability][]) {
    if (!out[needs]) out[cap] = false;
  }
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

/**
 * The order the workspace falls back through when the dashboard is not an
 * option.

 * Until the dashboard became a capability, "where do I send someone who cannot
 * open this page" had one answer, and every guard in the app hard-coded it. Now
 * it has to be computed, and the order below is simply the nav's own order, so
 * a member who loses the front page lands on the screen that would have been
 * their next tab rather than somewhere arbitrary.
 *
 * `waitlist` is absent on purpose even though `calendar` grants it: it is a
 * worklist inside the calendar, not a place to start the day.
 */
const LANDING_ORDER: [Capability, string][] = [
  ["patients", "patients"],
  ["calendar", "calendar"],
  ["conversations", "conversations"],
  ["documents", "documents"],
  ["invoices", "invoices"],
  ["expenses", "expenses"],
  ["campaigns", "campaigns"],
  ["automations", "automations"],
  ["ai", "ai"],
  ["settings", "settings"],
];

/**
 * The first section this access can actually open, as a path under the clinic.
 *
 * Falls back to `profile`, which is nobody's idea of a home page and is the
 * right answer anyway: it is the only screen inside a workspace with no
 * capability in front of it, so it is the one place a redirect can always
 * terminate. A member who lands there has been given no sections at all, which
 * is a misconfiguration to see rather than a loop to sit in.
 */
export function landingPathIn(slug: string, caps: CapabilityMap): string {
  if (caps.dashboard) return `/c/${slug}`;
  for (const [cap, path] of LANDING_ORDER) if (caps[cap]) return `/c/${slug}/${path}`;
  return `/c/${slug}/profile`;
}

/**
 * Grouping for the settings screen, so actions sit under the section they belong
 * to — and, where several sections are one place in the nav, under a heading
 * that says so.
 *
 * Invoices, Earnings and Expenses stay three separate permissions even though
 * they are now three tabs of one screen. Merging them would undo the reason
 * both of the newer two are top-level: the person who does the buying is not
 * the person who does the billing, and a doctor who may see what they earned
 * has no business in either. `group` is a label, not a gate.
 */
export const CAPABILITY_GROUPS: {
  section: Capability;
  actions: Capability[];
  /** A key in the `nav` dictionary. Sections sharing one get a heading. */
  group?: string;
}[] = [
  { section: "dashboard", actions: [] },
  { section: "conversations", actions: [] },
  { section: "calendar", actions: [] },
  { section: "patients", actions: ["patients.import", "patients.export", "patients.categories"] },
  { section: "documents", actions: ["documents.manage", "documents.void"] },
  { section: "invoices", actions: ["invoices.analytics"], group: "finance" },
  { section: "earnings", actions: [], group: "finance" },
  { section: "expenses", actions: [], group: "finance" },
  { section: "campaigns", actions: [] },
  { section: "automations", actions: [] },
  { section: "ai", actions: [] },
  { section: "settings", actions: ["settings.clinic", "settings.staff"] },
];
