import { FEATURES, type Feature, type FeatureMap } from "./features";

/**
 * What Clinicti sells (Yamen, 2026-11-27).
 *
 *   doctor       — one doctor and their receptionist: patient files, finance,
 *                  appointments, the WhatsApp inbox and basic automations.
 *                  No consent forms (2026-11-28).
 *   clinic_plus  — any number of staff in any roles, branches, and the online
 *                  parts: signing links, advanced automations, bulk messages,
 *                  the booking link and the machines.
 *   clinic_pro   — everything, plus the AI receptionist and the clinic's own
 *                  brand in place of Clinicti's.
 *
 * A plan is a preset, not a second gate. Choosing one writes its modules into
 * `clinics.features` (setClinicPlan), the same column every screen, action and
 * worker job already reads — so nothing had to learn about plans to obey one.
 * The agency can still switch a single module on or off for one clinic on top
 * of its plan, and the admin shows that difference ("Clinic+ · +AI").
 */

export const PLANS = ["doctor", "clinic_plus", "clinic_pro"] as const;
export type Plan = (typeof PLANS)[number];

export function isPlan(v: unknown): v is Plan {
  return typeof v === "string" && (PLANS as readonly string[]).includes(v);
}

/** Anything else — the old free-text "standard" — reads as the middle plan, which is what every clinic was given on 0118. */
export function asPlan(v: unknown): Plan {
  return isPlan(v) ? v : "clinic_plus";
}

/**
 * The modules a plan decides. Never the specialty charts (dental, aesthetic —
 * the specialty decides those), e-invoicing (a legal obligation a clinic opts
 * into on any plan) or the coordinator test.
 */
export const PLAN_MODULES: readonly Feature[] = [
  "conversations",
  "calendar",
  "patients",
  "documents",
  "invoices",
  "automations",
  "esign_remote",
  "automations_advanced",
  "campaigns",
  "booking",
  "devices",
  "branches",
  "ai",
  "branding",
];

// No consent forms on the Doctor plan, not even signed in the clinic (Yamen, 2026-11-28).
const DOCTOR: Feature[] = ["conversations", "calendar", "patients", "invoices", "automations"];
const CLINIC_PLUS: Feature[] = [...DOCTOR, "documents", "esign_remote", "automations_advanced", "campaigns", "booking", "devices", "branches"];
const CLINIC_PRO: Feature[] = [...CLINIC_PLUS, "ai", "branding"];

export type PlanProfile = {
  modules: readonly Feature[];
  /** Active members including the owner and anyone invited; null is no limit. */
  memberLimit: number | null;
};

export const PLAN_PROFILES: Record<Plan, PlanProfile> = {
  doctor: { modules: DOCTOR, memberLimit: 2 },
  clinic_plus: { modules: CLINIC_PLUS, memberLimit: null },
  clinic_pro: { modules: CLINIC_PRO, memberLimit: null },
};

/** The modules each plan adds over the one below it, for the plan cards. */
export function planAdds(plan: Plan): Feature[] {
  const i = PLANS.indexOf(plan);
  if (i === 0) return [...PLAN_PROFILES.doctor.modules];
  const below = new Set(PLAN_PROFILES[PLANS[i - 1]].modules);
  return PLAN_PROFILES[plan].modules.filter((m) => !below.has(m));
}

/** The plan's preset written over a clinic's map: plan modules set, everything else kept. */
export function applyPlan(features: FeatureMap, plan: Plan): FeatureMap {
  const on = new Set(PLAN_PROFILES[plan].modules);
  const next = { ...features };
  for (const m of PLAN_MODULES) next[m] = on.has(m);
  return next;
}

/** Where a clinic differs from its plan — the agency's hand-made exceptions. */
export function planOverrides(features: FeatureMap, plan: Plan): { added: Feature[]; removed: Feature[] } {
  const on = new Set(PLAN_PROFILES[plan].modules);
  const added: Feature[] = [];
  const removed: Feature[] = [];
  for (const m of PLAN_MODULES) {
    if (features[m] && !on.has(m)) added.push(m);
    else if (!features[m] && on.has(m)) removed.push(m);
  }
  return { added, removed };
}

/** The new-clinic form's starting map for a plan: the plan, and nothing opt-in beyond it. */
export function planFeatures(plan: Plan): FeatureMap {
  const on = new Set(PLAN_PROFILES[plan].modules);
  return Object.fromEntries(FEATURES.map((f) => [f, on.has(f)])) as FeatureMap;
}
