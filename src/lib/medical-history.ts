/**
 * A patient's medical history: once per patient, looked at again in each case.
 *
 * The dentist asked for "the history of the patient" with every new problem.
 * The complaint and its story belong to the case; the conditions and
 * medicines do not change with the tooth, so they are kept once, here, and
 * each case records that someone looked at them again. The ones that change
 * what a dentist may safely do — a blood thinner before an extraction,
 * bisphosphonates before an implant, an allergy before a prescription — are
 * shown as an alert on the patient's file, where nobody can miss them.
 *
 * Bilingual, unlike the chart: reception often takes this at the desk.
 */

export type MedicalCondition = {
  key: string;
  en: string;
  ar: string;
  /** Changes what may safely be done: shown in the file's header. */
  alert?: boolean;
};

export const CONDITIONS: MedicalCondition[] = [
  { key: "anticoagulant", en: "Blood thinners", ar: "مميّعات الدم", alert: true },
  { key: "bleeding", en: "Bleeding disorder", ar: "اضطراب تخثّر", alert: true },
  { key: "heart", en: "Heart disease", ar: "مرض في القلب", alert: true },
  { key: "bisphosphonates", en: "Bisphosphonates", ar: "بيسفوسفونات", alert: true },
  { key: "diabetes", en: "Diabetes", ar: "سكري", alert: true },
  { key: "pregnancy", en: "Pregnant", ar: "حامل", alert: true },
  { key: "hepatitis", en: "Hepatitis / HIV", ar: "التهاب الكبد / HIV", alert: true },
  { key: "hypertension", en: "High blood pressure", ar: "ضغط مرتفع" },
  { key: "asthma", en: "Asthma", ar: "ربو" },
  { key: "epilepsy", en: "Epilepsy", ar: "صرع" },
  { key: "kidney", en: "Kidney disease", ar: "مرض في الكلى" },
  { key: "smoker", en: "Smoker", ar: "مدخّن" },
];

/** Allergies dentists ask about first, offered as one tap. */
export const COMMON_ALLERGIES = ["Penicillin", "Latex", "Local anaesthetic", "NSAIDs"];

export type MedicalHistory = {
  conditions: string[];
  allergies: string;
  medications: string;
  notes: string;
  /** Who last changed it, and when — set by the server. */
  updatedAt?: string;
  updatedBy?: string;
};

/** What the server keeps: known conditions only, trimmed text, nothing else. */
export function cleanHistory(raw: unknown): MedicalHistory {
  const r = (raw ?? {}) as Partial<MedicalHistory>;
  const known = new Set(CONDITIONS.map((c) => c.key));
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return {
    conditions: Array.isArray(r.conditions) ? [...new Set(r.conditions.filter((c): c is string => typeof c === "string" && known.has(c)))] : [],
    allergies: text(r.allergies, 300),
    medications: text(r.medications, 1000),
    notes: text(r.notes, 2000),
  };
}

export function readHistory(raw: unknown): MedicalHistory {
  const r = (raw ?? {}) as Partial<MedicalHistory>;
  return { ...cleanHistory(raw), updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined, updatedBy: typeof r.updatedBy === "string" ? r.updatedBy : undefined };
}

/** The alerts for the header: allergies first, then the conditions that change what may be done. */
export function medicalAlerts(h: MedicalHistory, locale: string): string[] {
  const out: string[] = [];
  if (h.allergies.trim()) out.push(`${locale === "ar" ? "حساسية" : "Allergy"}: ${h.allergies.trim()}`);
  for (const c of CONDITIONS) if (c.alert && h.conditions.includes(c.key)) out.push(locale === "ar" ? c.ar : c.en);
  return out;
}

export function hasHistory(h: MedicalHistory): boolean {
  return h.conditions.length > 0 || !!h.allergies.trim() || !!h.medications.trim() || !!h.notes.trim();
}
