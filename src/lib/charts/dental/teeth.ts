/**
 * The teeth, in FDI notation — the numbering every dentist in the region was
 * trained on. Two digits: the quadrant, then the position counted from the
 * midline. 11 is the upper right central incisor, 48 the lower right wisdom
 * tooth; 5x–8x are the primary (milk) teeth in the same four quadrants.
 *
 * "Right" and "left" are always the patient's. The chart is drawn as the
 * dentist faces the patient, so the patient's right sits on the viewer's left —
 * in Arabic as in English. Only labels translate; the mouth never mirrors.
 */

export type Arch = "upper" | "lower";
export type Side = "right" | "left";
export type ToothKind = "incisor" | "canine" | "premolar" | "molar";
export type Dentition = "permanent" | "primary" | "mixed";

/** The five surfaces, stored under these keys whatever the tooth calls them. */
export type Surface = "M" | "D" | "O" | "B" | "L";
export const SURFACES: Surface[] = ["M", "D", "O", "B", "L"];

export type Tooth = {
  fdi: string;
  quadrant: number;
  /** 1 at the midline, outward to 8 (5 for a primary tooth). */
  position: number;
  arch: Arch;
  side: Side;
  primary: boolean;
  kind: ToothKind;
  /** Upper molars carry three roots; everything else is drawn from this. */
  roots: 1 | 2 | 3;
};

/** Display order, viewer's left to right: patient's right first. */
export const PERMANENT_UPPER = ["18", "17", "16", "15", "14", "13", "12", "11", "21", "22", "23", "24", "25", "26", "27", "28"];
export const PERMANENT_LOWER = ["48", "47", "46", "45", "44", "43", "42", "41", "31", "32", "33", "34", "35", "36", "37", "38"];
export const PRIMARY_UPPER = ["55", "54", "53", "52", "51", "61", "62", "63", "64", "65"];
export const PRIMARY_LOWER = ["85", "84", "83", "82", "81", "71", "72", "73", "74", "75"];

function kindOf(position: number, primary: boolean): ToothKind {
  if (position <= 2) return "incisor";
  if (position === 3) return "canine";
  // A primary tooth has no premolars: positions 4 and 5 are its two molars.
  if (primary) return "molar";
  return position <= 5 ? "premolar" : "molar";
}

const cache = new Map<string, Tooth>();

export function isTooth(fdi: string): boolean {
  if (!/^[1-8][1-8]$/.test(fdi)) return false;
  const q = Number(fdi[0]);
  const p = Number(fdi[1]);
  return q <= 4 || p <= 5;
}

export function tooth(fdi: string): Tooth {
  const hit = cache.get(fdi);
  if (hit) return hit;
  const quadrant = Number(fdi[0]);
  const position = Number(fdi[1]);
  const primary = quadrant >= 5;
  const q = primary ? quadrant - 4 : quadrant;
  const arch: Arch = q <= 2 ? "upper" : "lower";
  const side: Side = q === 1 || q === 4 ? "right" : "left";
  const kind = kindOf(position, primary);
  const roots: Tooth["roots"] = kind !== "molar" ? 1 : arch === "upper" ? 3 : 2;
  const t: Tooth = { fdi, quadrant, position, arch, side, primary, kind, roots };
  cache.set(fdi, t);
  return t;
}

/** Which dentition a patient most likely has, from their age. */
export function dentitionForAge(birthDate: string | null, today = new Date()): Dentition {
  if (!birthDate) return "permanent";
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return "permanent";
  const age = (today.getTime() - b.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 6) return "primary";
  if (age < 12.5) return "mixed";
  return "permanent";
}

const EN_KIND: Record<string, string> = {
  "incisor-1": "central incisor",
  "incisor-2": "lateral incisor",
  canine: "canine",
  "premolar-4": "first premolar",
  "premolar-5": "second premolar",
  "molar-6": "first molar",
  "molar-7": "second molar",
  "molar-8": "third molar",
  // Primary molars sit at positions 4 and 5.
  "molar-4": "first molar",
  "molar-5": "second molar",
};

/*
  Arabic tooth names agree in gender with the tooth: الرحى is feminine, القاطع,
  الناب and الضاحك masculine, and the adjectives that follow — upper, right,
  primary — take the same form.
*/
const AR_KIND: Record<string, { name: string; fem: boolean }> = {
  "incisor-1": { name: "القاطع الأوسط", fem: false },
  "incisor-2": { name: "القاطع الجانبي", fem: false },
  canine: { name: "الناب", fem: false },
  "premolar-4": { name: "الضاحك الأول", fem: false },
  "premolar-5": { name: "الضاحك الثاني", fem: false },
  "molar-6": { name: "الرحى الأولى", fem: true },
  "molar-7": { name: "الرحى الثانية", fem: true },
  "molar-8": { name: "الرحى الثالثة", fem: true },
  "molar-4": { name: "الرحى الأولى", fem: true },
  "molar-5": { name: "الرحى الثانية", fem: true },
};

function kindKey(t: Tooth): string {
  if (t.kind === "canine") return "canine";
  return `${t.kind}-${t.position}`;
}

export function toothName(t: Tooth, locale: string): string {
  const key = kindKey(t);
  if (locale === "ar") {
    const k = AR_KIND[key];
    const f = k.fem;
    const parts = [
      k.name,
      t.primary ? (f ? "اللبنية" : "اللبني") : "",
      t.arch === "upper" ? (f ? "العلوية" : "العلوي") : f ? "السفلية" : "السفلي",
      t.side === "right" ? (f ? "اليمنى" : "الأيمن") : f ? "اليسرى" : "الأيسر",
    ].filter(Boolean);
    const name = parts.join(" ");
    return t.kind === "molar" && t.position === 8 ? `${name} (ضرس العقل)` : name;
  }
  const en = `${t.arch === "upper" ? "Upper" : "Lower"} ${t.side} ${t.primary ? "primary " : ""}${EN_KIND[key]}`;
  return t.kind === "molar" && t.position === 8 ? `${en} (wisdom tooth)` : en;
}

/**
 * What a surface is called on this tooth. The keys never change; the names do:
 * the biting surface of a front tooth is incisal, not occlusal, its outer face
 * labial rather than buccal, and the inner face of an upper tooth is palatal.
 */
export function surfaceLabel(t: Tooth, s: Surface, locale: string): { short: string; long: string } {
  const front = t.kind === "incisor" || t.kind === "canine";
  const ar = locale === "ar";
  switch (s) {
    case "M":
      return { short: "M", long: ar ? "إنسي" : "Mesial" };
    case "D":
      return { short: "D", long: ar ? "وحشي" : "Distal" };
    case "O":
      return front ? { short: "I", long: ar ? "قاطع" : "Incisal" } : { short: "O", long: ar ? "إطباقي" : "Occlusal" };
    case "B":
      return front ? { short: "La", long: ar ? "شفوي" : "Labial" } : { short: "B", long: ar ? "دهليزي" : "Buccal" };
    case "L":
      return t.arch === "upper" ? { short: "P", long: ar ? "حنكي" : "Palatal" } : { short: "L", long: ar ? "لساني" : "Lingual" };
  }
}

/** Surfaces in the order dentists write them: MODBL → "MO", "MOD", "DO". */
export function surfaceCode(t: Tooth, surfaces: Surface[]): string {
  return SURFACES.filter((s) => surfaces.includes(s))
    .map((s) => surfaceLabel(t, s, "en").short)
    .join("");
}

/**
 * Which surface sits on which side of the drawn tooth.
 *
 * Buccal faces out of the arch — the top of the chart for an upper tooth, the
 * bottom for a lower one — and mesial faces the midline, so it is on the right
 * for a tooth drawn in the left half of the chart and on the left otherwise.
 */
export function surfaceAt(t: Tooth, region: "top" | "bottom" | "left" | "right" | "center"): Surface {
  if (region === "center") return "O";
  if (region === "top") return t.arch === "upper" ? "B" : "L";
  if (region === "bottom") return t.arch === "upper" ? "L" : "B";
  const mesialOnRight = t.side === "right";
  if (region === "right") return mesialOnRight ? "M" : "D";
  return mesialOnRight ? "D" : "M";
}

export const QUADRANT_OF_SITE: Record<string, number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
