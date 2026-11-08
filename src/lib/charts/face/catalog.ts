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
  // Reaching in to the side of the nose, so a point on the inner cheek is the cheek's (2026-11-08).
  { key: "cheek_r", en: "Cheek (R)", ar: "الخد الأيمن", group: "cheeks", x: 0.335, y: 0.475, w: 0.17, h: 0.1 },
  { key: "cheek_l", en: "Cheek (L)", ar: "الخد الأيسر", group: "cheeks", x: 0.665, y: 0.475, w: 0.17, h: 0.1 },
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

/**
 * Parts only a turned head shows: the back of the head and of the neck, where a
 * migraine's toxin goes (Yamen, 2026-11-08: "I wanted to put Botox in certain
 * places but it did not show"). They have no place on the front picture.
 */
export const BACK_ZONES: Zone[] = [
  { key: "occipital", en: "Back of head", ar: "مؤخرة الرأس", x: 0, y: 0, w: 0, h: 0 },
  { key: "nape", en: "Back of neck", ar: "مؤخرة الرقبة", x: 0, y: 0, w: 0, h: 0 },
];
const ALL_ZONES = [...FACE_ZONES, ...BACK_ZONES];

export const ZONE_BY_KEY = new Map(ALL_ZONES.map((z) => [z.key, z]));
export const isZone = (k: string) => ZONE_BY_KEY.has(k);

/** Quick picks: the areas doctors treat together. */
/**
 * The usual sets, one tap each (Yamen, 2026-11-07: "the full face, maybe the lips,
 * or the upper parts of the head, in addition to the neck").
 */
export const PRESETS: { key: string; en: string; zones: string[] }[] = [
  { key: "full", en: "Full face", zones: FACE_ZONES.filter((z) => z.key !== "scalp" && z.key !== "neck").map((z) => z.key) },
  { key: "upper", en: "Upper face · 3 areas", zones: ["forehead", "glabella", "crows_r", "crows_l"] },
  { key: "lips", en: "Lips", zones: ["lips"] },
  { key: "head", en: "Upper head", zones: ["scalp", "forehead", "temple_r", "temple_l"] },
  { key: "neck", en: "Neck", zones: ["neck"] },
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
  /** The clinic's own (0094), not one of the thirteen below. */
  custom?: boolean;
  /** No longer offered, still named by what was recorded with it. */
  archived?: boolean;
};

/** A kind of a treatment (0094): a TCA peel, PDO threads. It may have its own price and preselect a product. */
export type FaceVariant = { id: string; treatmentKey: string; name: string; nameAr: string | null; productId: string | null; active: boolean };

/**
 * What a recorded treatment's price counted, frozen on the entry (`chart_marks.detail`).
 * A built-in treatment's shape is in the code; a clinic's own can be renamed or
 * archived, so the entry keeps what it was when it was recorded.
 */
export type MarkDetail = { pricedBy?: PricedBy; units?: boolean; variant?: { id: string; name: string; nameAr: string | null } };

/** How a treatment counts, from the catalog or else from what its entry froze. */
export function shapeOf(key: string, detail?: MarkDetail | null): { pricedBy: PricedBy; units: boolean } | null {
  const t = FACE_TREATMENT_BY_KEY.get(key);
  if (t) return { pricedBy: t.pricedBy, units: !!t.units };
  return detail?.pricedBy ? { pricedBy: detail.pricedBy, units: !!detail.units } : null;
}

/** The thirteen and the clinic's own, as one: what is offered, and everything that can be named. */
export function mergeCatalog(custom: FaceTreatment[]): { offered: FaceTreatment[]; byKey: Map<string, FaceTreatment> } {
  const all = [...FACE_TREATMENTS, ...custom];
  return { offered: all.filter((t) => !t.archived), byKey: new Map(all.map((t) => [t.key, t])) };
}

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
    fits: ["forehead", "glabella", "crows_r", "crows_l", "temple_r", "temple_l", "scalp", "nose", "lips", "chin", "jaw_r", "jaw_l", "neck", "occipital", "nape"],
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
  // Added 2026-11-08, from the list Yamen approved (their kinds are rows: 0097).
  {
    key: "aes_biostim",
    en: "Biostimulator",
    ar: "محفّز الكولاجين",
    family: "filler",
    pricedBy: "syringe",
    fits: ["temple_r", "temple_l", "cheek_r", "cheek_l", "nasolabial_r", "nasolabial_l", "marionette_r", "marionette_l", "jaw_r", "jaw_l", "chin", "neck"],
    aliases: ["sculptra", "radiesse", "collagen", "كولاجين"],
  },
  { key: "aes_exosomes", en: "Exosomes", ar: "إكسوسومات", family: "skin", pricedBy: "session", fits: ALL, aliases: ["exosome", "إكسوسوم"] },
  { key: "aes_ipl", en: "IPL", ar: "آي بي إل", family: "laser", pricedBy: "session", fits: SKIN, aliases: ["photofacial", "فوتوفيشال"] },
  { key: "aes_carbon_peel", en: "Carbon laser peel", ar: "تقشير الكربون بالليزر", family: "laser", pricedBy: "session", fits: SKIN, aliases: ["carbon", "hollywood peel", "كربون"] },
  { key: "aes_microderm", en: "Microdermabrasion", ar: "صنفرة البشرة", family: "skin", pricedBy: "session", fits: SKIN, aliases: ["microdermabrasion", "صنفرة"] },
  { key: "aes_dermaplaning", en: "Dermaplaning", ar: "ديرمابلانينج", family: "skin", pricedBy: "session", fits: SKIN.filter((z) => z !== "neck"), aliases: ["dermaplane"] },
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
  // A migraine's: the temples, the back of the head and of the neck.
  temple_r: 20,
  temple_l: 20,
  occipital: 15,
  nape: 10,
};

/**
 * The picture a point was marked on: the front, and the head turned each way
 * (Yamen, 2026-11-07: "front, left, right, lateral frontal to the right and
 * left"). Left and right are the patient's: the left view shows their left side.
 * In the order the head turns, which is the order the chart offers them.
 */
export type FaceView = "left" | "front_left" | "front" | "front_right" | "right";
export const FACE_VIEWS: FaceView[] = ["left", "front_left", "front", "front_right", "right"];
export const VIEW_NAME: Record<FaceView, string> = {
  left: "Left",
  front_left: "Front-left",
  front: "Front",
  front_right: "Front-right",
  right: "Right",
};
/** On a phone, where five names have to fit across. */
export const VIEW_SHORT: Record<FaceView, string> = {
  left: "Left",
  front_left: "¾ Left",
  front: "Front",
  front_right: "¾ Right",
  right: "Right",
};
/** Under a turned picture, which side of the patient it shows. */
export const VIEW_CAPTION: Record<Exclude<FaceView, "front">, string> = {
  left: "The patient's left side",
  front_left: "Turned to show the patient's left side",
  front_right: "Turned to show the patient's right side",
  right: "The patient's right side",
};
export const VIEW_SRC: Record<FaceView, string> = {
  left: "/charts/face/face-left.webp",
  front_left: "/charts/face/face-front-left.webp",
  front: "/charts/face/face-front.webp",
  front_right: "/charts/face/face-front-right.webp",
  right: "/charts/face/face-right.webp",
};

type Place = { key: string; x: number; y: number; w: number; h: number };

/*
  Where each part is on the turned pictures, as on the front. They are cut from
  one generated sheet of the same mannequin (Canva MAHaQMeL7D8, saved as page 2
  of design DAHZTbj2560) and set at the front picture's size, 945 × 1264. A part
  hidden by the turn is simply not on that picture. The right-hand pictures are
  the left-hand places mirrored, checked on the pictures themselves.
*/
const SIDE: Record<Exclude<FaceView, "front">, Place[]> = {
  left: [
    { key: "scalp", x: 0.55, y: 0.13, w: 0.42, h: 0.14 },
    { key: "forehead", x: 0.22, y: 0.28, w: 0.2, h: 0.11 },
    { key: "glabella", x: 0.13, y: 0.375, w: 0.06, h: 0.04 },
    { key: "temple_l", x: 0.35, y: 0.365, w: 0.09, h: 0.08 },
    { key: "crows_l", x: 0.265, y: 0.425, w: 0.07, h: 0.05 },
    { key: "tear_l", x: 0.195, y: 0.462, w: 0.09, h: 0.03 },
    { key: "nose", x: 0.085, y: 0.48, w: 0.1, h: 0.1 },
    { key: "cheek_l", x: 0.31, y: 0.53, w: 0.2, h: 0.1 },
    { key: "nasolabial_l", x: 0.155, y: 0.57, w: 0.06, h: 0.06 },
    { key: "lips", x: 0.1, y: 0.625, w: 0.1, h: 0.06 },
    { key: "marionette_l", x: 0.17, y: 0.67, w: 0.06, h: 0.05 },
    { key: "chin", x: 0.13, y: 0.735, w: 0.1, h: 0.06 },
    { key: "jaw_l", x: 0.33, y: 0.705, w: 0.24, h: 0.07 },
    { key: "neck", x: 0.55, y: 0.83, w: 0.36, h: 0.16 },
    { key: "occipital", x: 0.82, y: 0.44, w: 0.14, h: 0.2 },
    { key: "nape", x: 0.74, y: 0.74, w: 0.12, h: 0.12 },
  ],
  front_left: [
    { key: "scalp", x: 0.48, y: 0.11, w: 0.46, h: 0.13 },
    { key: "forehead", x: 0.34, y: 0.255, w: 0.42, h: 0.1 },
    { key: "glabella", x: 0.28, y: 0.36, w: 0.07, h: 0.04 },
    { key: "temple_r", x: 0.11, y: 0.33, w: 0.05, h: 0.07 },
    { key: "temple_l", x: 0.63, y: 0.33, w: 0.08, h: 0.08 },
    { key: "crows_r", x: 0.105, y: 0.42, w: 0.04, h: 0.05 },
    { key: "crows_l", x: 0.56, y: 0.415, w: 0.06, h: 0.06 },
    { key: "tear_r", x: 0.18, y: 0.455, w: 0.08, h: 0.03 },
    { key: "tear_l", x: 0.42, y: 0.45, w: 0.12, h: 0.03 },
    { key: "nose", x: 0.255, y: 0.47, w: 0.1, h: 0.1 },
    { key: "cheek_r", x: 0.135, y: 0.53, w: 0.08, h: 0.08 },
    { key: "cheek_l", x: 0.47, y: 0.535, w: 0.18, h: 0.1 },
    { key: "nasolabial_r", x: 0.175, y: 0.575, w: 0.04, h: 0.05 },
    { key: "nasolabial_l", x: 0.335, y: 0.57, w: 0.05, h: 0.06 },
    { key: "lips", x: 0.27, y: 0.615, w: 0.19, h: 0.055 },
    { key: "marionette_r", x: 0.175, y: 0.665, w: 0.04, h: 0.05 },
    { key: "marionette_l", x: 0.37, y: 0.665, w: 0.05, h: 0.05 },
    { key: "jaw_r", x: 0.12, y: 0.66, w: 0.04, h: 0.08 },
    { key: "jaw_l", x: 0.53, y: 0.68, w: 0.17, h: 0.1 },
    { key: "chin", x: 0.27, y: 0.725, w: 0.14, h: 0.055 },
    { key: "neck", x: 0.48, y: 0.865, w: 0.4, h: 0.14 },
  ],
  right: [
    { key: "scalp", x: 0.45, y: 0.13, w: 0.42, h: 0.14 },
    { key: "forehead", x: 0.78, y: 0.28, w: 0.2, h: 0.11 },
    { key: "glabella", x: 0.87, y: 0.375, w: 0.06, h: 0.04 },
    { key: "temple_r", x: 0.65, y: 0.365, w: 0.09, h: 0.08 },
    { key: "crows_r", x: 0.735, y: 0.425, w: 0.07, h: 0.05 },
    { key: "tear_r", x: 0.805, y: 0.462, w: 0.09, h: 0.03 },
    { key: "nose", x: 0.915, y: 0.48, w: 0.1, h: 0.1 },
    { key: "cheek_r", x: 0.69, y: 0.53, w: 0.2, h: 0.1 },
    { key: "nasolabial_r", x: 0.845, y: 0.57, w: 0.06, h: 0.06 },
    { key: "lips", x: 0.9, y: 0.625, w: 0.1, h: 0.06 },
    { key: "marionette_r", x: 0.83, y: 0.67, w: 0.06, h: 0.05 },
    { key: "chin", x: 0.87, y: 0.735, w: 0.1, h: 0.06 },
    { key: "jaw_r", x: 0.67, y: 0.705, w: 0.24, h: 0.07 },
    { key: "neck", x: 0.45, y: 0.83, w: 0.36, h: 0.16 },
    { key: "occipital", x: 0.18, y: 0.44, w: 0.14, h: 0.2 },
    { key: "nape", x: 0.26, y: 0.74, w: 0.12, h: 0.12 },
  ],
  front_right: [
    { key: "scalp", x: 0.52, y: 0.11, w: 0.46, h: 0.13 },
    { key: "forehead", x: 0.66, y: 0.255, w: 0.42, h: 0.1 },
    { key: "glabella", x: 0.72, y: 0.36, w: 0.07, h: 0.04 },
    { key: "temple_l", x: 0.89, y: 0.33, w: 0.05, h: 0.07 },
    { key: "temple_r", x: 0.37, y: 0.33, w: 0.08, h: 0.08 },
    { key: "crows_l", x: 0.895, y: 0.42, w: 0.04, h: 0.05 },
    { key: "crows_r", x: 0.44, y: 0.415, w: 0.06, h: 0.06 },
    { key: "tear_l", x: 0.82, y: 0.455, w: 0.08, h: 0.03 },
    { key: "tear_r", x: 0.58, y: 0.45, w: 0.12, h: 0.03 },
    { key: "nose", x: 0.745, y: 0.47, w: 0.1, h: 0.1 },
    { key: "cheek_l", x: 0.865, y: 0.53, w: 0.08, h: 0.08 },
    { key: "cheek_r", x: 0.53, y: 0.535, w: 0.18, h: 0.1 },
    { key: "nasolabial_l", x: 0.825, y: 0.575, w: 0.04, h: 0.05 },
    { key: "nasolabial_r", x: 0.665, y: 0.57, w: 0.05, h: 0.06 },
    { key: "lips", x: 0.73, y: 0.615, w: 0.19, h: 0.055 },
    { key: "marionette_l", x: 0.825, y: 0.665, w: 0.04, h: 0.05 },
    { key: "marionette_r", x: 0.63, y: 0.665, w: 0.05, h: 0.05 },
    { key: "jaw_l", x: 0.88, y: 0.66, w: 0.04, h: 0.08 },
    { key: "jaw_r", x: 0.47, y: 0.68, w: 0.17, h: 0.1 },
    { key: "chin", x: 0.73, y: 0.725, w: 0.14, h: 0.055 },
    { key: "neck", x: 0.52, y: 0.865, w: 0.4, h: 0.14 },
  ],
};

/** The parts drawn on a picture, with their names. */
export function zonesOn(view: FaceView): Zone[] {
  if (view === "front") return FACE_ZONES;
  return SIDE[view].map((p) => ({ ...ZONE_BY_KEY.get(p.key)!, x: p.x, y: p.y, w: p.w, h: p.h }));
}

/**
 * Where a spot marked on one picture is on another (Yamen, 2026-11-08: "when I put
 * a treatment on the front I want to see it when I press on the right"). It keeps
 * its place within its part: as far across and down that part's oval as it was.
 * Null when the other picture does not show that part (the left cheek from the
 * right). Near enough to find the work, which is what the turned views are for.
 */
export function placeOn(p: { x: number; y: number; v?: FaceView }, zone: string, view: FaceView): { x: number; y: number } | null {
  const from = p.v ?? "front";
  if (from === view) return { x: p.x, y: p.y };
  const a = zonesOn(from).find((z) => z.key === zone);
  const b = zonesOn(view).find((z) => z.key === zone);
  if (!b) return null;
  if (!a) return { x: b.x, y: b.y };
  let dx = (p.x - a.x) / (a.w / 2);
  let dy = (p.y - a.y) / (a.h / 2);
  // A spot just outside its part (it went to the nearest) stays just outside, not far off.
  const r = Math.hypot(dx, dy);
  if (r > 1.2) {
    dx = (dx / r) * 1.2;
    dy = (dy / r) * 1.2;
  }
  return { x: b.x + (dx * b.w) / 2, y: b.y + (dy * b.h) / 2 };
}
export const isView = (v: unknown): v is FaceView => typeof v === "string" && (FACE_VIEWS as string[]).includes(v);

/** An exact spot the doctor worked on, as a share of its picture, 0–1 (2026-11-08). */
export type FacePoint = { x: number; y: number; v?: FaceView };

/** An area of the face as recorded: its units, when dosed in them, and the exact spots, when marked. */
export type Area = { zone: string; units?: number; points?: FacePoint[] };

/** The picture's width over its height (945 × 1264): a step across is shorter than a step down. */
const ASPECT = 945 / 1264;

/**
 * The part of the face a spot is in, on its picture: the area whose oval it is
 * deepest inside; between areas, the one whose edge is nearest on the picture, up
 * to a short way off. A tap on the background beside the head belongs to none.
 * The server asks the same question of every point it is sent.
 */
export function zoneAt(x: number, y: number, view: FaceView = "front"): string | null {
  let inside: string | null = null;
  let insideD = Infinity;
  let near: string | null = null;
  let nearGap = Infinity;
  for (const z of zonesOn(view)) {
    const dx = (x - z.x) / (z.w / 2);
    const dy = (y - z.y) / (z.h / 2);
    const d = dx * dx + dy * dy;
    if (d <= 1) {
      if (d < insideD) {
        insideD = d;
        inside = z.key;
      }
      continue;
    }
    // How far outside the oval, along the line from its middle, in the picture's own proportions.
    const gap = Math.hypot((x - z.x) * ASPECT, y - z.y) * (1 - 1 / Math.sqrt(d));
    if (gap < nearGap) {
      nearGap = gap;
      near = z.key;
    }
  }
  // Off a part by a little still counts as that part: anywhere on the face takes a dot.
  return inside ?? (nearGap <= 0.09 ? near : null);
}

/** The areas in face order — the order the chart lists them in, whatever order they were tapped. */
export function inFaceOrder<T extends { zone: string }>(areas: T[]): T[] {
  const at = (k: string) => ALL_ZONES.findIndex((z) => z.key === k);
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
export function pickFacePrice<T extends { chartKey: string; variant: string | null }>(list: T[], key: string, productId: string | null, variantId: string | null = null): T | null {
  // The kind of work first (a TCA peel costs more than a glycolic), then the product, then the treatment.
  const exact = (id: string | null) => (id ? list.find((p) => p.chartKey === key && p.variant === id) : undefined);
  return exact(variantId) ?? exact(productId) ?? list.find((p) => p.chartKey === key && p.variant === null) ?? null;
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
  m: { treatmentKey: string; label: string; labelAr: string; areas: Area[]; quantity: number | null; detail?: MarkDetail | null },
  serviceName: { name: string; nameAr: string | null } | null,
  locale: string
): string {
  const t = shapeOf(m.treatmentKey, m.detail);
  const v = m.detail?.variant;
  const variant = v ? (locale === "ar" ? v.nameAr || v.name : v.name) : null;
  let name = serviceName ? (locale === "ar" ? serviceName.nameAr || serviceName.name : serviceName.name) : locale === "ar" ? m.labelAr || m.label : m.label;
  // The variant's own price is already named after it; any other line says which kind it was.
  if (variant && !name.includes(variant)) name = `${name} (${variant})`;
  const where = whereText(m.areas.map((a) => a.zone), locale);
  const parts: string[] = [];
  if (t && t.pricedBy !== "session" && m.quantity != null) parts.push(amountText(t.pricedBy, Number(m.quantity), locale));
  const units = t?.units ? m.areas.reduce((n, a) => n + (a.units ?? 0), 0) : null;
  if (units && t?.pricedBy !== "unit") parts.push(unitsText(units, locale));
  return `${name}${where ? ` — ${where}` : ""}${parts.length ? ` (${parts.join(" · ")})` : ""}`.slice(0, 200);
}
