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

/**
 * What must follow the patient onto other screens — the board, the calendar,
 * the prescription — and nothing more: the allergies and the conditions that
 * change what may be done. The medicines and the notes stay in the file.
 * Null when there is nothing to warn about.
 */
export type MedicalFlags = { allergies: string; conditions: string[] };

export function medicalFlags(raw: unknown): MedicalFlags | null {
  const h = readHistory(raw);
  const conditions = h.conditions.filter((k) => CONDITIONS.some((c) => c.key === k && c.alert));
  const allergies = h.allergies.trim();
  return allergies || conditions.length ? { allergies, conditions } : null;
}

/** The flags as the header words them. */
export function flagAlerts(f: MedicalFlags | null | undefined, locale: string): string[] {
  return f ? medicalAlerts({ conditions: f.conditions, allergies: f.allergies, medications: "", notes: "" }, locale) : [];
}

/*
  Allergies are typed as a family more often than as a drug: "Penicillin",
  "NSAIDs", "sulfa". A prescription names the drug, and usually by its brand —
  Augmentin, Brufen, Cataflam. Each family below is what a clinic here would
  write for it, in either language, and the drugs and brands it covers. A
  warning that misses Augmentin for a penicillin allergy is worse than none,
  because it is trusted.
*/
const FAMILIES: { names: string[]; drugs: string[] }[] = [
  {
    names: ["penicillin", "بنسلين", "بنيسلين"],
    drugs: [
      "penicillin", "amoxicillin", "amoxil", "augmentin", "amoxiclav", "co-amoxiclav", "ampicillin", "cloxacillin",
      "flucloxacillin", "piperacillin", "tazocin", "bactoclav", "megamox", "curam", "اموكسيسيلين", "اموكسيل", "اوجمنتين", "بنسلين",
    ],
  },
  {
    names: ["cephalosporin", "سيفالوسبورين"],
    drugs: ["cephalexin", "keflex", "cefuroxime", "zinnat", "cefixime", "suprax", "ceftriaxone", "rocephin", "cefadroxil", "cefaclor", "cefdinir", "zinat"],
  },
  {
    names: ["nsaid", "nsaids", "مضادات الالتهاب", "aspirin", "اسبرين"],
    drugs: [
      "ibuprofen", "brufen", "advil", "nurofen", "diclofenac", "voltaren", "cataflam", "naproxen", "aspirin", "aspocid", "ketoprofen",
      "mefenamic", "ponstan", "celecoxib", "celebrex", "meloxicam", "mobic", "etoricoxib", "arcoxia", "piroxicam", "indomethacin",
      "ketorolac", "toradol", "بروفين", "فولتارين", "كتافلام", "اسبرين", "ارتوكسيا", "اركوكسيا",
    ],
  },
  {
    names: ["sulfa", "sulfonamide", "سلفا"],
    drugs: ["sulfamethoxazole", "co-trimoxazole", "cotrimoxazole", "septrin", "bactrim", "sulfadiazine", "sulfasalazine"],
  },
  {
    names: ["macrolide", "erythromycin", "اريثرومايسين"],
    drugs: ["erythromycin", "azithromycin", "zithromax", "clarithromycin", "klacid", "ازيثرومايسين", "زيثروماكس", "كلاسيد"],
  },
  {
    names: ["local anaesthetic", "local anesthetic", "مخدر موضعي", "بنج"],
    drugs: ["lidocaine", "lignocaine", "xylocaine", "articaine", "septanest", "mepivacaine", "scandonest", "bupivacaine", "prilocaine", "benzocaine"],
  },
  {
    names: ["codeine", "opioid", "كودين"],
    drugs: ["codeine", "tramadol", "tramal", "morphine", "oxycodone", "solpadeine", "panadol extra codeine", "ترامادول"],
  },
];

/** Lower case, Arabic letters folded the way search folds them, no marks. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The allergy a medicine runs into, as the patient's history words it — or
 * null. Matches a family by its drugs and brands, and anything else written
 * as an allergy by name, so "Latex" never warns but "Brufen" under "NSAIDs"
 * and "Tramadol" under "Tramadol" both do.
 */
export function allergyFor(allergies: string, medicine: string): string | null {
  const med = fold(medicine);
  if (med.length < 3) return null;
  for (const raw of allergies.split(/[,،;؛\n/+]+/)) {
    const allergy = raw.trim();
    const a = fold(allergy);
    if (a.length < 3) continue;
    const family = FAMILIES.find((f) => f.names.some((n) => a.includes(fold(n))));
    if (family?.drugs.some((d) => med.includes(fold(d)))) return allergy;
    // By name: the allergy in the medicine ("amoxicillin" in "Amoxicillin 500mg"), or its first word among the allergy's.
    const word = med.split(" ")[0];
    if (a.length >= 4 && med.includes(a)) return allergy;
    if (word.length >= 4 && a.split(" ").includes(word)) return allergy;
  }
  return null;
}

export function hasHistory(h: MedicalHistory): boolean {
  return h.conditions.length > 0 || !!h.allergies.trim() || !!h.medications.trim() || !!h.notes.trim();
}
