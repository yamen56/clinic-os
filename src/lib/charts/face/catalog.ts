/**
 * The face chart's catalog: the parts of the face a doctor treats, and the
 * aesthetic treatments done on them.
 *
 * Like the dental catalog it lives in code, so a better name or a missing
 * treatment reaches every clinic at once and the server never takes a
 * treatment's name from the browser. Its keys start `aes_` so they never meet
 * a dental key on the one price list (services.chart_key).
 *
 * The chart speaks English, like the dental chart; the Arabic names are for
 * what the patient reads — the invoice line.
 */

/** A part of the face, as a share of the face picture: its centre and size, 0–1. */
export type Zone = {
  key: string;
  en: string;
  ar: string;
  /** The pair it belongs to — both crow's feet are one area to price. */
  group?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * Placed on public/charts/face/face-front.webp — a generated mannequin head,
 * eyes closed and no person's features (Yamen, 2026-10-28: not a real
 * person's face, not a drawing). The picture is 945×1264; (R) is the
 * patient's right, which is the viewer's left.
 */
export const FACE_ZONES: Zone[] = [
  { key: "scalp", en: "Scalp", ar: "فروة الرأس", x: 0.5, y: 0.125, w: 0.4, h: 0.13 },
  { key: "forehead", en: "Forehead", ar: "الجبهة", x: 0.5, y: 0.266, w: 0.42, h: 0.1 },
  { key: "glabella", en: "Glabella", ar: "بين الحاجبين", x: 0.5, y: 0.341, w: 0.09, h: 0.05 },
  { key: "temple_r", en: "Temple (R)", ar: "الصدغ الأيمن", group: "temples", x: 0.245, y: 0.3, w: 0.065, h: 0.08 },
  { key: "temple_l", en: "Temple (L)", ar: "الصدغ الأيسر", group: "temples", x: 0.755, y: 0.3, w: 0.065, h: 0.08 },
  { key: "crows_r", en: "Crow's feet (R)", ar: "حول العين اليمنى", group: "crows", x: 0.267, y: 0.386, w: 0.055, h: 0.075 },
  { key: "crows_l", en: "Crow's feet (L)", ar: "حول العين اليسرى", group: "crows", x: 0.733, y: 0.386, w: 0.055, h: 0.075 },
  { key: "tear_r", en: "Tear trough (R)", ar: "تحت العين اليمنى", group: "tear", x: 0.361, y: 0.419, w: 0.13, h: 0.03 },
  { key: "tear_l", en: "Tear trough (L)", ar: "تحت العين اليسرى", group: "tear", x: 0.639, y: 0.419, w: 0.13, h: 0.03 },
  { key: "nose", en: "Nose", ar: "الأنف", x: 0.5, y: 0.446, w: 0.13, h: 0.108 },
  { key: "cheek_r", en: "Cheek (R)", ar: "الخد الأيمن", group: "cheeks", x: 0.322, y: 0.473, w: 0.14, h: 0.09 },
  { key: "cheek_l", en: "Cheek (L)", ar: "الخد الأيسر", group: "cheeks", x: 0.678, y: 0.473, w: 0.14, h: 0.09 },
  { key: "nasolabial_r", en: "Nasolabial fold (R)", ar: "خط الابتسامة الأيمن", group: "nasolabial", x: 0.405, y: 0.528, w: 0.045, h: 0.06 },
  { key: "nasolabial_l", en: "Nasolabial fold (L)", ar: "خط الابتسامة الأيسر", group: "nasolabial", x: 0.595, y: 0.528, w: 0.045, h: 0.06 },
  { key: "lips", en: "Lips", ar: "الشفاه", x: 0.5, y: 0.582, w: 0.21, h: 0.06 },
  { key: "marionette_r", en: "Marionette line (R)", ar: "خط الماريونيت الأيمن", group: "marionette", x: 0.4, y: 0.631, w: 0.045, h: 0.06 },
  { key: "marionette_l", en: "Marionette line (L)", ar: "خط الماريونيت الأيسر", group: "marionette", x: 0.6, y: 0.631, w: 0.045, h: 0.06 },
  { key: "jaw_r", en: "Jawline (R)", ar: "خط الفك الأيمن", group: "jaw", x: 0.31, y: 0.61, w: 0.06, h: 0.1 },
  { key: "jaw_l", en: "Jawline (L)", ar: "خط الفك الأيسر", group: "jaw", x: 0.69, y: 0.61, w: 0.06, h: 0.1 },
  { key: "chin", en: "Chin", ar: "الذقن", x: 0.5, y: 0.677, w: 0.16, h: 0.055 },
  { key: "neck", en: "Neck", ar: "الرقبة", x: 0.5, y: 0.83, w: 0.34, h: 0.13 },
];

/** A pair read as one, when both sides were done: "Crow's feet", not "Crow's feet (R), Crow's feet (L)". */
const GROUPS: Record<string, { en: string; ar: string }> = {
  temples: { en: "Temples", ar: "الصدغين" },
  crows: { en: "Crow's feet", ar: "حول العينين" },
  tear: { en: "Tear troughs", ar: "تحت العينين" },
  cheeks: { en: "Cheeks", ar: "الخدين" },
  nasolabial: { en: "Nasolabial folds", ar: "خطوط الابتسامة" },
  marionette: { en: "Marionette lines", ar: "خطوط الماريونيت" },
  jaw: { en: "Jawline", ar: "خط الفك" },
};

export const ZONE_BY_KEY = new Map(FACE_ZONES.map((z) => [z.key, z]));
export const isZone = (k: string) => ZONE_BY_KEY.has(k);

/** Quick picks: the areas doctors treat together. */
export const PRESETS: { key: string; en: string; zones: string[] }[] = [
  { key: "upper", en: "Upper face · 3 areas", zones: ["forehead", "glabella", "crows_r", "crows_l"] },
  { key: "lips", en: "Lips", zones: ["lips"] },
  { key: "full", en: "Full face", zones: FACE_ZONES.filter((z) => z.key !== "scalp" && z.key !== "neck").map((z) => z.key) },
];

/** What a treatment is, for its colour on the face and in the lists. */
export type Family = "toxin" | "filler" | "skin" | "laser" | "threads" | "contour";
export const FAMILIES: Family[] = ["toxin", "filler", "skin", "laser", "threads", "contour"];

/** Told apart by lightness as well as hue, so they read on the skin and to the colour-blind. */
export const FAMILY_COLOR: Record<Family, string> = {
  toxin: "#0f7f8a",
  filler: "#b83d68",
  skin: "#a8701a",
  laser: "#6a46c0",
  threads: "#3f4753",
  contour: "#2f7d4f",
};

/**
 * What a treatment's price counts:
 *   area     the areas done — a left and right pair is one area
 *   unit     the units given, all areas together
 *   syringe  the syringes used
 *   thread   the threads placed
 *   session  one sitting, whatever was covered
 */
export type PricedBy = "area" | "unit" | "syringe" | "thread" | "session";

export type FaceTreatment = {
  key: string;
  en: string;
  ar: string;
  family: Family;
  pricedBy: PricedBy;
  /** The areas it is done on. */
  fits: string[];
  /** Dosed per area in units, recorded with each area. */
  units?: boolean;
  /** What staff actually type: "botox", "بوتوكس". Searched, never shown. */
  aliases?: string[];
};

const ALL = FACE_ZONES.map((z) => z.key);
const SKIN = ALL.filter((k) => k !== "scalp");

export const FACE_TREATMENTS: FaceTreatment[] = [
  {
    key: "aes_toxin",
    en: "Botulinum toxin",
    ar: "بوتوكس",
    family: "toxin",
    pricedBy: "area",
    units: true,
    fits: ["forehead", "glabella", "crows_r", "crows_l", "nose", "lips", "chin", "jaw_r", "jaw_l", "neck"],
    aliases: ["botox", "dysport", "xeomin", "بوتكس"],
  },
  {
    key: "aes_filler",
    en: "Dermal filler",
    ar: "فيلر",
    family: "filler",
    pricedBy: "syringe",
    fits: ["lips", "cheek_r", "cheek_l", "tear_r", "tear_l", "nasolabial_r", "nasolabial_l", "marionette_r", "marionette_l", "chin", "jaw_r", "jaw_l", "temple_r", "temple_l", "nose"],
    aliases: ["filler", "hyaluronic", "فلر"],
  },
  { key: "aes_booster", en: "Skin booster", ar: "محفز بشرة", family: "skin", pricedBy: "session", fits: SKIN, aliases: ["profhilo", "booster", "بروفايلو"] },
  { key: "aes_prp", en: "PRP", ar: "بلازما", family: "skin", pricedBy: "session", fits: ALL, aliases: ["plasma", "بلازما"] },
  { key: "aes_meso", en: "Mesotherapy", ar: "ميزوثيرابي", family: "skin", pricedBy: "session", fits: ALL, aliases: ["meso"] },
  { key: "aes_microneedling", en: "Microneedling", ar: "ديرمابن", family: "skin", pricedBy: "session", fits: SKIN, aliases: ["dermapen", "ديرما بن"] },
  { key: "aes_peel", en: "Chemical peel", ar: "تقشير كيميائي", family: "skin", pricedBy: "session", fits: SKIN, aliases: ["peel", "تقشير"] },
  { key: "aes_facial", en: "Medical facial", ar: "تنظيف بشرة", family: "skin", pricedBy: "session", fits: SKIN, aliases: ["hydrafacial", "facial", "تنظيف"] },
  {
    key: "aes_threads",
    en: "Thread lift",
    ar: "خيوط شد",
    family: "threads",
    pricedBy: "thread",
    fits: ["temple_r", "temple_l", "cheek_r", "cheek_l", "nasolabial_r", "nasolabial_l", "jaw_r", "jaw_l", "chin", "neck"],
    aliases: ["threads", "pdo", "خيوط"],
  },
  { key: "aes_laser_hair", en: "Laser hair removal", ar: "ليزر إزالة الشعر", family: "laser", pricedBy: "session", fits: ["lips", "chin", "cheek_r", "cheek_l", "jaw_r", "jaw_l", "neck", "forehead"], aliases: ["laser", "ليزر"] },
  { key: "aes_laser_skin", en: "Fractional laser", ar: "ليزر فراكشنال", family: "laser", pricedBy: "session", fits: SKIN, aliases: ["co2", "fraxel", "فراكشنال"] },
  { key: "aes_tightening", en: "Skin tightening (HIFU / RF)", ar: "شد البشرة (هايفو)", family: "laser", pricedBy: "session", fits: SKIN, aliases: ["hifu", "rf", "هايفو"] },
  { key: "aes_fat", en: "Fat dissolving", ar: "إذابة الدهون", family: "contour", pricedBy: "session", fits: ["chin", "jaw_r", "jaw_l", "cheek_r", "cheek_l", "neck"], aliases: ["lipolysis", "kybella", "تذويب"] },
];

export const FACE_TREATMENT_BY_KEY = new Map(FACE_TREATMENTS.map((t) => [t.key, t]));

/** A treatment's units as it usually starts on each area, for the doctor to adjust. */
export const DEFAULT_UNITS: Record<string, number> = {
  forehead: 10,
  glabella: 20,
  crows_r: 12,
  crows_l: 12,
  nose: 4,
  lips: 4,
  chin: 6,
  jaw_r: 25,
  jaw_l: 25,
  neck: 30,
};

/** One area of a treatment as recorded: where, and the units given there when it is dosed. */
export type Area = { zone: string; units?: number };

/** The areas in face order — the order the chart lists them in, whatever order they were tapped. */
export function inFaceOrder<T extends { zone: string }>(areas: T[]): T[] {
  const at = (k: string) => FACE_ZONES.findIndex((z) => z.key === k);
  return [...areas].sort((a, b) => at(a.zone) - at(b.zone));
}

/** The areas as one counts them for a price: a left and right pair is one area. */
export function areaCount(zones: string[]): number {
  return new Set(zones.map((k) => ZONE_BY_KEY.get(k)?.group ?? k)).size;
}

/**
 * Where on the face, in words: "Forehead, Glabella, Crow's feet". A pair done
 * on both sides reads as the pair; one side reads as that side.
 */
export function whereText(zones: string[], locale: string): string {
  const keys = inFaceOrder(zones.map((zone) => ({ zone }))).map((a) => a.zone);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const z = ZONE_BY_KEY.get(k);
    if (!z) continue;
    if (z.group) {
      if (seen.has(z.group)) continue;
      const both = FACE_ZONES.filter((x) => x.group === z.group).every((x) => keys.includes(x.key));
      if (both) {
        seen.add(z.group);
        out.push(locale === "ar" ? GROUPS[z.group].ar : GROUPS[z.group].en);
        continue;
      }
    }
    out.push(locale === "ar" ? z.ar : z.en);
  }
  return out.join(locale === "ar" ? "، " : ", ");
}

/**
 * What the price of a treatment counts, as recorded: its areas, its units, or
 * the syringes, threads or sessions the doctor entered. Never below one.
 */
export function quantityOf(t: FaceTreatment, areas: Area[], count: number): number {
  switch (t.pricedBy) {
    case "area":
      return Math.max(1, areaCount(areas.map((a) => a.zone)));
    case "unit":
      return Math.max(1, areas.reduce((n, a) => n + (a.units ?? 0), 0));
    case "session":
      return 1;
    default:
      return Math.max(1, Math.round(count));
  }
}

/** The units given, all areas together; null for a treatment not dosed in units. */
export function totalUnits(t: FaceTreatment, areas: Area[]): number | null {
  return t.units ? areas.reduce((n, a) => n + (a.units ?? 0), 0) : null;
}

/**
 * A treatment's price on the list: with this product, when the clinic prices
 * it by product (a Juvederm syringe dearer than another), else the
 * treatment's own — as a crown's price follows its material.
 */
export function pickFacePrice<T extends { chartKey: string; variant: string | null }>(list: T[], key: string, productId: string | null): T | null {
  return (productId ? list.find((p) => p.chartKey === key && p.variant === productId) : undefined) ?? list.find((p) => p.chartKey === key && p.variant === null) ?? null;
}

/** What a product is counted in (0085 aesthetic_products.unit). */
export type ProductUnit = "u" | "ml" | "syringe" | "vial" | "thread" | "piece";

const UNIT_WORDS: Record<ProductUnit, { en: [string, string]; ar: [string, string] }> = {
  u: { en: ["{n}u", "{n}u"], ar: ["{n} وحدة", "{n} وحدة"] },
  ml: { en: ["{n} ml", "{n} ml"], ar: ["{n} مل", "{n} مل"] },
  syringe: { en: ["1 syringe", "{n} syringes"], ar: ["سرنجة واحدة", "{n} سرنجات"] },
  vial: { en: ["1 vial", "{n} vials"], ar: ["عبوة واحدة", "{n} عبوات"] },
  thread: { en: ["1 thread", "{n} threads"], ar: ["خيط واحد", "{n} خيوط"] },
  piece: { en: ["1 piece", "{n} pieces"], ar: ["قطعة واحدة", "{n} قطع"] },
};

/** "54u", "2 syringes", "1.5 ml" — an amount of a product, in the reader's language. */
export function productAmount(unit: ProductUnit, qty: number, locale: string): string {
  const w = UNIT_WORDS[unit][locale === "ar" ? "ar" : "en"];
  const n = Math.round(qty * 100) / 100;
  return (n === 1 ? w[0] : w[1]).replace("{n}", String(n));
}

/** The whole price: the list's price for one, times what it counts. */
export function feeOf(unitPrice: number | null, quantity: number): number | null {
  return unitPrice == null ? null : Math.round(unitPrice * quantity * 100) / 100;
}

/** The words a quantity is read in, by what it counts. */
export type AmountWords = Record<PricedBy, { one: string; many: string }> & { units: string };

const AMOUNT: Record<"en" | "ar", AmountWords> = {
  en: {
    area: { one: "1 area", many: "{n} areas" },
    unit: { one: "1 unit", many: "{n} units" },
    syringe: { one: "1 syringe", many: "{n} syringes" },
    thread: { one: "1 thread", many: "{n} threads" },
    session: { one: "1 session", many: "{n} sessions" },
    units: "{n}u",
  },
  ar: {
    area: { one: "منطقة واحدة", many: "{n} مناطق" },
    unit: { one: "وحدة واحدة", many: "{n} وحدة" },
    syringe: { one: "سرنجة واحدة", many: "{n} سرنجات" },
    thread: { one: "خيط واحد", many: "{n} خيوط" },
    session: { one: "جلسة واحدة", many: "{n} جلسات" },
    units: "{n} وحدة",
  },
};

/** "3 areas", "2 syringes", in the reader's language. */
export function amountText(by: PricedBy, n: number, locale: string): string {
  const w = AMOUNT[locale === "ar" ? "ar" : "en"][by];
  return n === 1 ? w.one : w.many.replace("{n}", String(n));
}

/** "54u" — a toxin's dose, in the reader's language. */
export function unitsText(n: number, locale: string): string {
  return AMOUNT[locale === "ar" ? "ar" : "en"].units.replace("{n}", String(n));
}

/**
 * The invoice line for face work, as the patient reads it: the price list's
 * name for the treatment (or the catalog's), where on the face, and how much —
 * "Botulinum toxin — Forehead, Glabella, Crow's feet (3 areas · 54u)",
 * "فيلر — الشفاه (سرنجة واحدة)".
 */
export function faceLineText(
  m: { treatmentKey: string; label: string; labelAr: string; areas: Area[]; quantity: number | null },
  serviceName: { name: string; nameAr: string | null } | null,
  locale: string
): string {
  const t = FACE_TREATMENT_BY_KEY.get(m.treatmentKey);
  const name = serviceName ? (locale === "ar" ? serviceName.nameAr || serviceName.name : serviceName.name) : locale === "ar" ? m.labelAr || m.label : m.label;
  const where = whereText(m.areas.map((a) => a.zone), locale);
  const parts: string[] = [];
  if (t && t.pricedBy !== "session" && m.quantity != null) parts.push(amountText(t.pricedBy, Number(m.quantity), locale));
  const units = t ? totalUnits(t, m.areas) : null;
  if (units && t?.pricedBy !== "unit") parts.push(unitsText(units, locale));
  return `${name}${where ? ` — ${where}` : ""}${parts.length ? ` (${parts.join(" · ")})` : ""}`.slice(0, 200);
}
