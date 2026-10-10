import { SPECIALTIES, type Specialty } from "./specialties";
import type { Feature } from "./features";
import type { DeviceKind, FileKind } from "./imaging/kinds";

/**
 * What each specialty brings to a clinic — the one place it is written down.
 *
 * Picking a specialty for a clinic (or adding a department to a medical
 * centre) is not a label: it switches on the modules that field needs, puts
 * that field's machines first when a doctor connects one, and decides which
 * kinds of result a patient's Files are sorted by. A dental clinic gets the
 * tooth chart, x-ray sensors and OPGs, and x-rays and photos; a cardiology
 * clinic gets ECGs, echo and monitors, and ECGs and reports; a medical centre
 * with both gets both.
 *
 * Automation recipes are the other half of what a specialty brings; they are
 * matched by the same specialty names (lib/clinic-provision installRecipes).
 * Adding a specialty here, or a module or machine to one, is all that is
 * needed for every screen that shows these to follow.
 */
export type SpecialtyProfile = {
  /** Clinic modules it switches on. */
  modules: Feature[];
  /** The machines its clinics connect, the most usual first. */
  devices: DeviceKind[];
  /** What its patients' files hold, in the order Files offers them. */
  files: FileKind[];
};

export const SPECIALTY_PROFILES: Record<Specialty, SpecialtyProfile> = {
  general: { modules: [], devices: ["monitor", "ecg", "ultrasound", "camera", "lab"], files: ["report", "lab", "ecg", "photo"] },
  dental: { modules: ["dental"], devices: ["xray", "opg", "cbct", "camera", "scanner"], files: ["xray", "photo", "scan"] },
  dermatology: { modules: [], devices: ["camera", "scanner"], files: ["photo", "report"] },
  ophthalmology: { modules: [], devices: ["eye", "camera"], files: ["scan", "photo", "report"] },
  obgyn: { modules: [], devices: ["ultrasound", "monitor", "lab"], files: ["ultrasound", "report", "lab"] },
  pediatrics: { modules: [], devices: ["monitor", "ecg", "lab"], files: ["report", "lab", "ecg"] },
  orthopedics: { modules: [], devices: ["xray", "ultrasound", "camera"], files: ["xray", "photo", "report"] },
  physiotherapy: { modules: [], devices: ["camera", "scanner", "monitor"], files: ["photo", "report"] },
  ent: { modules: [], devices: ["endoscope", "monitor", "camera"], files: ["photo", "report"] },
  cardiology: { modules: [], devices: ["ecg", "ultrasound", "monitor"], files: ["ecg", "ultrasound", "report"] },
  nutrition: { modules: [], devices: ["monitor", "lab"], files: ["report", "lab"] },
  psychiatry: { modules: [], devices: [], files: ["report"] },
  plastic_surgery: { modules: [], devices: ["camera", "scanner"], files: ["photo", "scan"] },
  urology: { modules: [], devices: ["ultrasound", "endoscope", "lab"], files: ["ultrasound", "photo", "lab", "report"] },
  internal_medicine: { modules: [], devices: ["ecg", "ultrasound", "monitor", "lab"], files: ["ecg", "ultrasound", "lab", "report"] },
};

const uniq = <T,>(xs: T[]) => xs.filter((x, i) => xs.indexOf(x) === i);

/**
 * Everything a clinic's specialties bring together, in the order they were
 * named — a medical centre's primary field first. "general" is always under
 * it all: every clinic can connect a monitor and keep a report.
 */
export function profileFor(specialties: readonly string[]): SpecialtyProfile {
  const own = specialties.filter((s): s is Specialty => (SPECIALTIES as readonly string[]).includes(s) && s !== "general");
  const all = [...own.map((s) => SPECIALTY_PROFILES[s]), SPECIALTY_PROFILES.general];
  return {
    modules: uniq(all.flatMap((p) => p.modules)),
    devices: uniq(all.flatMap((p) => p.devices)),
    files: uniq(all.flatMap((p) => p.files)),
  };
}

/** The modules a set of specialties switches on — what the agency's specialty choice turns on or off. */
export function modulesFor(specialties: readonly string[]): Feature[] {
  return profileFor(specialties).modules;
}

/** Every module some specialty decides, so a change of specialty can switch off what no longer applies. */
export const SPECIALTY_MODULES: Feature[] = uniq(Object.values(SPECIALTY_PROFILES).flatMap((p) => p.modules));
