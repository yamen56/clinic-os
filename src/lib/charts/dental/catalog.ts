/**
 * The dental treatment catalog: everything a dentist records on a tooth.
 *
 * Separate from the clinic's Services on purpose. Services are what reception
 * books and invoices — "تنظيف أسنان، 30 دقيقة، 25 دينار". This is the clinical
 * vocabulary — "حشوة تجميلية، إنسي-إطباقي، سن 16" — and a clinic should not have
 * to type eighty procedures into its price list before the chart is usable.
 *
 * It lives in code so that every entry is guaranteed a drawing (`look`) and so
 * that a better name or a missing procedure reaches every clinic at once. A
 * clinic adds its own entries on top; they borrow a look from this list.
 */

import type { Surface, Tooth, ToothKind } from "./teeth";

export type Scope = "surface" | "tooth" | "span" | "quadrant" | "arch" | "mouth";
export type EntryKind = "finding" | "procedure";

export type Category =
  | "findings"
  | "diagnostic"
  | "preventive"
  | "restorative"
  | "endodontic"
  | "periodontic"
  | "fixed"
  | "removable"
  | "implant"
  | "surgery"
  | "ortho"
  | "pediatric"
  | "cosmetic";

export const PROCEDURE_CATEGORIES: Category[] = [
  "restorative",
  "endodontic",
  "surgery",
  "fixed",
  "implant",
  "preventive",
  "periodontic",
  "diagnostic",
  "ortho",
  "pediatric",
  "removable",
  "cosmetic",
];

/**
 * How an entry changes the drawn tooth. Each one is a layer in `tooth-art.tsx`;
 * `dot` is the honest answer for work that has no shape on a tooth (an exam, an
 * x-ray) — a small marker under the number rather than an invented picture.
 */
export type Look =
  | "caries"
  | "filling"
  | "inlay"
  | "sealant"
  | "core"
  | "post"
  | "pulp"
  | "rct"
  | "apico"
  | "crown"
  | "veneer"
  | "pontic"
  | "implant"
  | "extraction"
  | "missing"
  | "impacted"
  | "unerupted"
  | "root"
  | "fracture"
  | "wear"
  | "stain"
  | "lesion"
  | "mobility"
  | "furcation"
  | "recession"
  | "gum"
  | "rotation"
  | "graft"
  | "bracket"
  | "band"
  | "splint"
  | "denture"
  | "dot";

/** The looks a clinic may borrow for a treatment of its own. */
export const BORROWABLE_LOOKS: Look[] = ["filling", "crown", "veneer", "rct", "extraction", "implant", "gum", "bracket", "dot"];

export type DetailOption = { key: string; en: string; ar: string };
export type DetailField = { key: "material" | "canals" | "grade" | "type"; options: DetailOption[] };

export type Treatment = {
  key: string;
  kind: EntryKind;
  category: Category;
  en: string;
  ar: string;
  abbr?: string;
  scope: Scope;
  needsSurfaces?: boolean;
  look: Look;
  /** Teeth it belongs on. Absent means any. Search still finds it anywhere. */
  fits?: { kinds?: ToothKind[]; primary?: boolean; arch?: "upper" | "lower"; position?: number[] };
  /** What staff actually say: "سحب عصب", "تلبيسة", "ext". Searched, never shown. */
  aliases?: string[];
  details?: DetailField[];
  /** Set on a clinic's own entry. */
  custom?: { addedBy: string; addedAt: string };
};

const MATERIAL_FILLING: DetailField = {
  key: "material",
  options: [
    { key: "composite", en: "Composite", ar: "تجميلية (ضوئية)" },
    { key: "amalgam", en: "Amalgam", ar: "أملغم (فضية)" },
    { key: "gic", en: "Glass ionomer", ar: "زجاجية أيونومرية" },
  ],
};
const MATERIAL_CROWN: DetailField = {
  key: "material",
  options: [
    { key: "zirconia", en: "Zirconia", ar: "زركون" },
    { key: "emax", en: "E-max", ar: "إي ماكس" },
    { key: "pfm", en: "Porcelain-fused-to-metal (PFM)", ar: "خزف على معدن" },
    { key: "metal", en: "Full metal", ar: "معدن كامل" },
    { key: "temporary", en: "Temporary", ar: "مؤقت" },
  ],
};
const MATERIAL_INDIRECT: DetailField = {
  key: "material",
  options: [
    { key: "ceramic", en: "Ceramic", ar: "خزف" },
    { key: "composite", en: "Composite", ar: "تجميلية" },
    { key: "gold", en: "Gold", ar: "ذهب" },
  ],
};
const MATERIAL_VENEER: DetailField = {
  key: "material",
  options: [
    { key: "porcelain", en: "Porcelain", ar: "خزف" },
    { key: "emax", en: "E-max", ar: "إي ماكس" },
    { key: "composite", en: "Composite", ar: "تجميلية" },
  ],
};
const CANALS: DetailField = {
  key: "canals",
  options: [
    { key: "1", en: "1 canal", ar: "قناة واحدة" },
    { key: "2", en: "2 canals", ar: "قناتان" },
    { key: "3", en: "3 canals", ar: "3 قنوات" },
    { key: "4", en: "4 canals", ar: "4 قنوات" },
  ],
};
const MOBILITY_GRADE: DetailField = {
  key: "grade",
  options: [
    { key: "1", en: "Grade I", ar: "الدرجة الأولى" },
    { key: "2", en: "Grade II", ar: "الدرجة الثانية" },
    { key: "3", en: "Grade III", ar: "الدرجة الثالثة" },
  ],
};

const BACK_TEETH: ToothKind[] = ["premolar", "molar"];

export const BUILT_IN: Treatment[] = [
  // ── Findings: what is in the mouth, before anybody does anything ────────────
  { key: "caries", kind: "finding", category: "findings", en: "Caries", ar: "تسوس", scope: "surface", needsSurfaces: true, look: "caries", aliases: ["decay", "cavity", "نخر", "سوس"] },
  { key: "caries_recurrent", kind: "finding", category: "findings", en: "Recurrent caries", ar: "تسوس ثانوي", scope: "surface", needsSurfaces: true, look: "caries", aliases: ["secondary caries", "تسوس تحت الحشوة"] },
  { key: "fracture", kind: "finding", category: "findings", en: "Fractured tooth", ar: "كسر في السن", scope: "tooth", look: "fracture", aliases: ["broken", "مكسور"] },
  { key: "crack", kind: "finding", category: "findings", en: "Cracked tooth", ar: "شرخ في السن", scope: "tooth", look: "fracture", aliases: ["crack", "شعر"] },
  {
    key: "wear", kind: "finding", category: "findings", en: "Tooth wear", ar: "تآكل السن", scope: "tooth", look: "wear", aliases: ["attrition", "abrasion", "erosion", "سحل"],
    details: [{ key: "type", options: [
      { key: "attrition", en: "Attrition", ar: "سحل" },
      { key: "abrasion", en: "Abrasion", ar: "انسحال" },
      { key: "erosion", en: "Erosion", ar: "تآكل حمضي" },
    ] }],
  },
  { key: "missing", kind: "finding", category: "findings", en: "Missing tooth", ar: "سن مفقود", scope: "tooth", look: "missing", aliases: ["absent", "مخلوع", "ناقص"] },
  { key: "impacted", kind: "finding", category: "findings", en: "Impacted tooth", ar: "سن منطمر", scope: "tooth", look: "impacted", aliases: ["مطمور"] },
  { key: "unerupted", kind: "finding", category: "findings", en: "Unerupted tooth", ar: "سن غير بازغ", scope: "tooth", look: "unerupted", aliases: ["لم يطلع"] },
  { key: "retained_root", kind: "finding", category: "findings", en: "Retained root", ar: "جذر متبقٍّ", scope: "tooth", look: "root", aliases: ["root remnant", "بقايا جذر"] },
  { key: "malposition", kind: "finding", category: "findings", en: "Rotated / malpositioned", ar: "دوران أو سوء وضع", scope: "tooth", look: "rotation", aliases: ["rotation", "crowding", "مزدحم"] },
  { key: "diastema", kind: "finding", category: "findings", en: "Diastema", ar: "فراغ بين الأسنان", scope: "tooth", look: "dot", aliases: ["gap", "فلجة"] },
  { key: "lesion", kind: "finding", category: "findings", en: "Periapical lesion / abscess", ar: "آفة حول ذروية / خراج", scope: "tooth", look: "lesion", aliases: ["abscess", "granuloma", "cyst", "خراج", "التهاب"] },
  { key: "mobility", kind: "finding", category: "findings", en: "Mobility", ar: "حركة السن", scope: "tooth", look: "mobility", aliases: ["loose", "متحرك", "رخو"], details: [MOBILITY_GRADE] },
  { key: "furcation", kind: "finding", category: "findings", en: "Furcation involvement", ar: "إصابة مفترق الجذور", scope: "tooth", look: "furcation", fits: { kinds: ["molar"] } },
  { key: "recession", kind: "finding", category: "findings", en: "Gingival recession", ar: "انحسار اللثة", scope: "tooth", look: "recession", aliases: ["receding gum", "تراجع اللثة"] },
  { key: "hypoplasia", kind: "finding", category: "findings", en: "Enamel hypoplasia / fluorosis", ar: "نقص تكلس المينا / تفلّور", scope: "tooth", look: "stain", aliases: ["fluorosis", "MIH"] },
  { key: "discoloration", kind: "finding", category: "findings", en: "Discoloration", ar: "تصبغ السن", scope: "tooth", look: "stain", aliases: ["stain", "اصفرار", "تلون"] },

  // ── Diagnostic ──────────────────────────────────────────────────────────────
  { key: "exam_comprehensive", kind: "procedure", category: "diagnostic", en: "Comprehensive oral exam", ar: "فحص فموي شامل", scope: "mouth", look: "dot", aliases: ["exam", "كشف", "فحص"] },
  { key: "exam_periodic", kind: "procedure", category: "diagnostic", en: "Periodic exam", ar: "فحص دوري", scope: "mouth", look: "dot", aliases: ["check-up", "recall", "مراجعة"] },
  { key: "xray_pa", kind: "procedure", category: "diagnostic", en: "Periapical X-ray", ar: "صورة أشعة ذروية", abbr: "PA", scope: "tooth", look: "dot", aliases: ["xray", "x-ray", "صورة", "أشعة"] },
  { key: "xray_bw", kind: "procedure", category: "diagnostic", en: "Bitewing X-ray", ar: "صورة أشعة مجنّحة", abbr: "BW", scope: "quadrant", look: "dot", aliases: ["xray", "صورة"] },
  { key: "xray_opg", kind: "procedure", category: "diagnostic", en: "Panoramic X-ray", ar: "صورة بانوراما", abbr: "OPG", scope: "mouth", look: "dot", aliases: ["panorama", "بانوراما", "صورة"] },
  { key: "cbct", kind: "procedure", category: "diagnostic", en: "CBCT scan", ar: "أشعة مقطعية ثلاثية الأبعاد", abbr: "CBCT", scope: "mouth", look: "dot", aliases: ["3d", "مقطعية"] },
  { key: "vitality", kind: "procedure", category: "diagnostic", en: "Pulp vitality test", ar: "اختبار حيوية اللب", scope: "tooth", look: "dot", aliases: ["cold test", "EPT"] },

  // ── Preventive ──────────────────────────────────────────────────────────────
  { key: "scaling", kind: "procedure", category: "preventive", en: "Scaling & polishing", ar: "تنظيف وإزالة الجير", scope: "mouth", look: "dot", aliases: ["cleaning", "prophy", "تنظيف", "تلميع", "جير"] },
  { key: "fluoride", kind: "procedure", category: "preventive", en: "Fluoride application", ar: "تطبيق الفلورايد", scope: "mouth", look: "dot", aliases: ["varnish", "فلورايد"] },
  { key: "sealant", kind: "procedure", category: "preventive", en: "Fissure sealant", ar: "سد الشقوق", scope: "tooth", look: "sealant", fits: { kinds: BACK_TEETH }, aliases: ["sealant", "عازل"] },
  { key: "space_maintainer", kind: "procedure", category: "preventive", en: "Space maintainer", ar: "حافظ مسافة", scope: "tooth", look: "band", aliases: ["حافظ مكان"] },
  { key: "ohi", kind: "procedure", category: "preventive", en: "Oral hygiene instruction", ar: "تعليمات العناية بالفم", abbr: "OHI", scope: "mouth", look: "dot", aliases: ["تثقيف"] },

  // ── Restorative ─────────────────────────────────────────────────────────────
  { key: "filling_composite", kind: "procedure", category: "restorative", en: "Composite filling", ar: "حشوة تجميلية (ضوئية)", abbr: "COMP", scope: "surface", needsSurfaces: true, look: "filling", aliases: ["filling", "resin", "white filling", "حشوة", "حشوة بيضاء", "ضوئية"] },
  { key: "filling_amalgam", kind: "procedure", category: "restorative", en: "Amalgam filling", ar: "حشوة أملغم (فضية)", abbr: "AM", scope: "surface", needsSurfaces: true, look: "filling", aliases: ["filling", "silver", "حشوة", "فضية", "ملغم"] },
  { key: "filling_gic", kind: "procedure", category: "restorative", en: "Glass ionomer filling", ar: "حشوة زجاجية أيونومرية", abbr: "GIC", scope: "surface", needsSurfaces: true, look: "filling", aliases: ["filling", "حشوة"] },
  { key: "filling_temp", kind: "procedure", category: "restorative", en: "Temporary filling", ar: "حشوة مؤقتة", abbr: "TEMP", scope: "surface", needsSurfaces: true, look: "filling", aliases: ["filling", "حشوة", "مؤقتة"] },
  { key: "inlay", kind: "procedure", category: "restorative", en: "Inlay", ar: "حشوة داخلية (إنلاي)", scope: "surface", needsSurfaces: true, look: "inlay", details: [MATERIAL_INDIRECT], aliases: ["inlay", "إنلاي"] },
  { key: "onlay", kind: "procedure", category: "restorative", en: "Onlay", ar: "حشوة خارجية (أونلاي)", scope: "surface", needsSurfaces: true, look: "inlay", details: [MATERIAL_INDIRECT], aliases: ["onlay", "أونلاي"] },
  { key: "core_buildup", kind: "procedure", category: "restorative", en: "Core build-up", ar: "بناء قلب السن", scope: "tooth", look: "core", aliases: ["build up", "بناء"] },
  { key: "post_core", kind: "procedure", category: "restorative", en: "Post & core", ar: "وتد وقلب", scope: "tooth", look: "post", aliases: ["post", "وتد", "دبوس"] },
  { key: "pulp_cap_direct", kind: "procedure", category: "restorative", en: "Direct pulp capping", ar: "تغطية لبية مباشرة", scope: "tooth", look: "pulp", aliases: ["pulp cap", "تغطية"] },
  { key: "pulp_cap_indirect", kind: "procedure", category: "restorative", en: "Indirect pulp capping", ar: "تغطية لبية غير مباشرة", scope: "tooth", look: "pulp", aliases: ["pulp cap", "تغطية"] },

  // ── Endodontic ──────────────────────────────────────────────────────────────
  { key: "rct", kind: "procedure", category: "endodontic", en: "Root canal treatment", ar: "علاج عصب", abbr: "RCT", scope: "tooth", look: "rct", details: [CANALS], aliases: ["root canal", "endo", "سحب عصب", "عصب", "قناة"] },
  { key: "rct_retreat", kind: "procedure", category: "endodontic", en: "Root canal retreatment", ar: "إعادة علاج العصب", abbr: "Re-RCT", scope: "tooth", look: "rct", details: [CANALS], aliases: ["retreatment", "عصب"] },
  { key: "pulpotomy", kind: "procedure", category: "endodontic", en: "Pulpotomy", ar: "بتر اللب", scope: "tooth", look: "pulp", fits: { primary: true }, aliases: ["بتر عصب", "عصب"] },
  { key: "pulpectomy", kind: "procedure", category: "endodontic", en: "Pulpectomy", ar: "استئصال اللب", scope: "tooth", look: "rct", fits: { primary: true }, aliases: ["عصب"] },
  { key: "apicoectomy", kind: "procedure", category: "endodontic", en: "Apicoectomy", ar: "قطع ذروة الجذر", scope: "tooth", look: "apico", aliases: ["apico", "قطع جذر"] },
  { key: "apexification", kind: "procedure", category: "endodontic", en: "Apexification", ar: "تحفيز تكوين الذروة", scope: "tooth", look: "rct", aliases: ["MTA"] },
  { key: "endo_opening", kind: "procedure", category: "endodontic", en: "Emergency opening & drainage", ar: "فتح طارئ وتصريف", scope: "tooth", look: "pulp", aliases: ["pulpal opening", "فتح عصب", "تصريف"] },

  // ── Oral surgery ────────────────────────────────────────────────────────────
  { key: "extraction", kind: "procedure", category: "surgery", en: "Simple extraction", ar: "خلع بسيط", abbr: "EXT", scope: "tooth", look: "extraction", aliases: ["extraction", "ext", "خلع", "قلع", "شلع"] },
  { key: "extraction_surgical", kind: "procedure", category: "surgery", en: "Surgical extraction", ar: "خلع جراحي", abbr: "S-EXT", scope: "tooth", look: "extraction", aliases: ["extraction", "خلع", "جراحي"] },
  { key: "extraction_wisdom", kind: "procedure", category: "surgery", en: "Impacted wisdom tooth removal", ar: "خلع ضرس عقل منطمر", scope: "tooth", look: "extraction", fits: { position: [8] }, aliases: ["wisdom", "ضرس العقل", "خلع"] },
  { key: "root_removal", kind: "procedure", category: "surgery", en: "Root remnant removal", ar: "إزالة بقايا جذر", scope: "tooth", look: "extraction", aliases: ["خلع", "جذر"] },
  { key: "incision_drainage", kind: "procedure", category: "surgery", en: "Incision & drainage", ar: "شق وتصريف خراج", abbr: "I&D", scope: "tooth", look: "dot", aliases: ["abscess", "خراج"] },
  { key: "frenectomy", kind: "procedure", category: "surgery", en: "Frenectomy", ar: "قطع اللجام", scope: "mouth", look: "dot", aliases: ["frenum", "لجام"] },
  { key: "biopsy", kind: "procedure", category: "surgery", en: "Biopsy", ar: "خزعة", scope: "mouth", look: "dot" },
  { key: "alveoloplasty", kind: "procedure", category: "surgery", en: "Alveoloplasty", ar: "تسوية العظم السنخي", scope: "quadrant", look: "dot", aliases: ["تسوية عظم"] },
  { key: "dry_socket", kind: "procedure", category: "surgery", en: "Dry socket treatment", ar: "علاج السنخ الجاف", scope: "tooth", look: "dot", aliases: ["alveolar osteitis", "سنخ جاف"] },

  // ── Fixed prosthetics ───────────────────────────────────────────────────────
  { key: "crown", kind: "procedure", category: "fixed", en: "Crown", ar: "تاج (تلبيسة)", scope: "tooth", look: "crown", details: [MATERIAL_CROWN], aliases: ["cap", "تلبيسة", "تاج", "زركون", "كراون"] },
  { key: "bridge", kind: "procedure", category: "fixed", en: "Bridge", ar: "جسر", scope: "span", look: "crown", details: [MATERIAL_CROWN], aliases: ["bridge", "جسر"] },
  { key: "veneer", kind: "procedure", category: "fixed", en: "Veneer", ar: "قشرة (فينير)", scope: "tooth", look: "veneer", details: [MATERIAL_VENEER], aliases: ["veneer", "فينير", "قشور", "lumineers"] },
  { key: "hollywood_smile", kind: "procedure", category: "fixed", en: "Hollywood smile", ar: "ابتسامة هوليوود", scope: "span", look: "veneer", details: [MATERIAL_VENEER], aliases: ["smile makeover", "هوليوود", "ابتسامة"] },
  { key: "crown_recement", kind: "procedure", category: "fixed", en: "Re-cement crown", ar: "إعادة تثبيت تاج", scope: "tooth", look: "crown", aliases: ["تثبيت", "تلبيسة"] },
  { key: "crown_removal", kind: "procedure", category: "fixed", en: "Crown removal", ar: "إزالة تاج", scope: "tooth", look: "dot", aliases: ["فك تلبيسة"] },

  // ── Implants ────────────────────────────────────────────────────────────────
  { key: "implant", kind: "procedure", category: "implant", en: "Implant placement", ar: "زرع غرسة (زراعة)", abbr: "IMP", scope: "tooth", look: "implant", aliases: ["implant", "زراعة", "زرعة", "غرسة"] },
  { key: "implant_abutment", kind: "procedure", category: "implant", en: "Implant abutment", ar: "دعامة الزرعة", scope: "tooth", look: "implant", aliases: ["abutment", "دعامة"] },
  { key: "implant_crown", kind: "procedure", category: "implant", en: "Implant crown", ar: "تاج على زرعة", scope: "tooth", look: "crown", details: [MATERIAL_CROWN], aliases: ["تلبيسة زراعة"] },
  { key: "bone_graft", kind: "procedure", category: "implant", en: "Bone graft", ar: "طعم عظمي", scope: "tooth", look: "graft", aliases: ["graft", "طعم"] },
  { key: "sinus_lift", kind: "procedure", category: "implant", en: "Sinus lift", ar: "رفع الجيب الأنفي", scope: "tooth", look: "graft", fits: { arch: "upper", kinds: BACK_TEETH }, aliases: ["رفع جيب"] },
  { key: "implant_denture", kind: "procedure", category: "implant", en: "Implant-supported denture (All-on-4)", ar: "طقم على زرعات", scope: "arch", look: "denture", aliases: ["all on 4", "overdenture"] },

  // ── Preventive gum care and periodontics ────────────────────────────────────
  { key: "srp", kind: "procedure", category: "periodontic", en: "Deep scaling & root planing", ar: "تنظيف عميق وتسوية الجذور", abbr: "SRP", scope: "quadrant", look: "dot", aliases: ["deep cleaning", "تنظيف عميق"] },
  { key: "gingivectomy", kind: "procedure", category: "periodontic", en: "Gingivectomy", ar: "قطع اللثة", scope: "tooth", look: "gum", aliases: ["قص لثة"] },
  { key: "crown_lengthening", kind: "procedure", category: "periodontic", en: "Crown lengthening", ar: "إطالة التاج", scope: "tooth", look: "gum", aliases: ["تطويل"] },
  { key: "gum_graft", kind: "procedure", category: "periodontic", en: "Gum graft", ar: "طعم لثوي", scope: "tooth", look: "gum", aliases: ["soft tissue graft", "زراعة لثة"] },
  { key: "flap_surgery", kind: "procedure", category: "periodontic", en: "Flap surgery", ar: "جراحة الشريحة اللثوية", scope: "quadrant", look: "dot", aliases: ["flap"] },
  { key: "splinting", kind: "procedure", category: "periodontic", en: "Splinting", ar: "تجبير الأسنان", scope: "span", look: "splint", aliases: ["splint", "تجبير", "تثبيت"] },

  // ── Orthodontics ────────────────────────────────────────────────────────────
  { key: "bracket", kind: "procedure", category: "ortho", en: "Bracket", ar: "حاصرة تقويم (براكيت)", scope: "tooth", look: "bracket", aliases: ["braces", "تقويم", "براكيت"] },
  { key: "band", kind: "procedure", category: "ortho", en: "Orthodontic band", ar: "حلقة تقويم", scope: "tooth", look: "band", fits: { kinds: ["molar"] }, aliases: ["حلقة"] },
  { key: "aligners", kind: "procedure", category: "ortho", en: "Clear aligners", ar: "تقويم شفاف", scope: "arch", look: "dot", aliases: ["invisalign", "شفاف"] },
  { key: "retainer", kind: "procedure", category: "ortho", en: "Retainer", ar: "مثبّت تقويم", scope: "arch", look: "dot", aliases: ["مثبت"] },
  { key: "ortho_adjust", kind: "procedure", category: "ortho", en: "Orthodontic adjustment", ar: "شد التقويم", scope: "mouth", look: "dot", aliases: ["adjustment", "شد", "تقويم"] },
  { key: "debond", kind: "procedure", category: "ortho", en: "Debonding", ar: "فك التقويم", scope: "mouth", look: "dot", aliases: ["فك"] },

  // ── Pediatric ───────────────────────────────────────────────────────────────
  { key: "ssc", kind: "procedure", category: "pediatric", en: "Stainless steel crown", ar: "تاج معدني للأطفال", abbr: "SSC", scope: "tooth", look: "crown", fits: { primary: true }, aliases: ["تلبيسة أطفال"] },
  { key: "extraction_primary", kind: "procedure", category: "pediatric", en: "Primary tooth extraction", ar: "خلع سن لبني", scope: "tooth", look: "extraction", fits: { primary: true }, aliases: ["خلع", "سن حليب"] },

  // ── Removable prosthetics ───────────────────────────────────────────────────
  { key: "denture_complete", kind: "procedure", category: "removable", en: "Complete denture", ar: "طقم أسنان كامل", scope: "arch", look: "denture", aliases: ["denture", "طقم"] },
  { key: "denture_partial", kind: "procedure", category: "removable", en: "Partial denture", ar: "طقم أسنان جزئي", scope: "span", look: "denture", aliases: ["denture", "طقم", "جزئي"] },
  { key: "denture_repair", kind: "procedure", category: "removable", en: "Denture repair / reline", ar: "إصلاح أو تبطين الطقم", scope: "arch", look: "dot", aliases: ["reline", "تبطين"] },

  // ── Cosmetic and other ──────────────────────────────────────────────────────
  {
    key: "whitening", kind: "procedure", category: "cosmetic", en: "Teeth whitening", ar: "تبييض الأسنان", scope: "mouth", look: "dot", aliases: ["bleaching", "تبييض"],
    details: [{ key: "type", options: [
      { key: "office", en: "In-office", ar: "في العيادة" },
      { key: "home", en: "Home kit", ar: "منزلي" },
    ] }],
  },
  { key: "bonding", kind: "procedure", category: "cosmetic", en: "Composite bonding", ar: "ترميم تجميلي (بوندنغ)", scope: "tooth", look: "veneer", aliases: ["bonding", "بوندنغ"] },
  { key: "gum_contouring", kind: "procedure", category: "cosmetic", en: "Gum contouring / depigmentation", ar: "تجميل اللثة / إزالة التصبغ", scope: "arch", look: "dot", aliases: ["gum bleaching", "لثة"] },
  { key: "night_guard", kind: "procedure", category: "cosmetic", en: "Night guard", ar: "واقي ليلي", scope: "arch", look: "dot", aliases: ["bruxism", "صرير", "جبيرة"] },
  { key: "desensitization", kind: "procedure", category: "cosmetic", en: "Desensitization", ar: "علاج حساسية الأسنان", scope: "tooth", look: "dot", aliases: ["sensitivity", "حساسية"] },
];

export const BUILT_IN_BY_KEY = new Map(BUILT_IN.map((t) => [t.key, t]));

/** The treatment behind a key, built-in or the clinic's own. */
export function findTreatment(key: string, custom: Treatment[]): Treatment | undefined {
  return BUILT_IN_BY_KEY.get(key) ?? custom.find((c) => c.key === key);
}

/** Does this treatment belong on this tooth? Used to filter, never to forbid. */
export function fitsTooth(tr: Treatment, t: Tooth): boolean {
  const f = tr.fits;
  if (!f) return true;
  if (f.primary !== undefined && f.primary !== t.primary) return false;
  if (f.kinds && !f.kinds.includes(t.kind)) return false;
  if (f.arch && f.arch !== t.arch) return false;
  if (f.position && !f.position.includes(t.position)) return false;
  return true;
}

/**
 * The same skeleton as the database's `ar_normalize`, so the catalog search
 * forgives what the patient search forgives: hamza forms, taa marbuta, alif
 * maqsura, tatweel and diacritics.
 */
export function arNormalize(s: string): string {
  return s
    .replace(/[ـً-ْٰ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .trim();
}

export function matchesQuery(tr: Treatment, q: string): boolean {
  const n = arNormalize(q);
  if (!n) return true;
  const hay = [tr.ar, tr.en, tr.abbr ?? "", ...(tr.aliases ?? [])].map(arNormalize);
  return n.split(/\s+/).every((w) => hay.some((h) => h.includes(w)));
}

export function treatmentLabel(tr: { en: string; ar: string }, locale: string): string {
  return locale === "ar" ? tr.ar : tr.en;
}

/** The other language's name — under the Arabic, the English medical term. */
export function treatmentSubLabel(tr: { en: string; ar: string; abbr?: string }, locale: string): string {
  const other = locale === "ar" ? tr.en : tr.ar;
  return tr.abbr ? `${other} · ${tr.abbr}` : other;
}

/** True when the entry, once done, means the tooth is no longer there. */
export function removesTooth(look: Look): boolean {
  return look === "extraction";
}

export type { Surface };
