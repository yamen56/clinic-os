/**
 * The steps a treatment is made of, and how far along one is.
 *
 * A filling is one act: tapped, it is done. A root canal is not — access,
 * working length, cleaning and shaping, irrigation, obturation, often over two
 * or three visits — and an implant, a full arch or a denture is weeks of them.
 * The dentist asked to record what was done at each visit ("did we do the
 * irrigation? the obturation?"), the length of every canal, and how many
 * sessions it took, so the clinic can charge for it and the next doctor knows
 * where it stands.
 *
 * Like the catalog, the steps live in code: every clinic gets the same sound
 * sequence, in the words dentists here use, and a better step reaches all of
 * them at once. A treatment with no steps here stays one tap.
 *
 * A treatment is finished when its required steps are done; optional ones may
 * come before or after. A repeatable step (a medicament change, a healing
 * review) may be recorded as often as it happens.
 */

import type { Tooth } from "./teeth";
import { BUILT_IN_BY_KEY, type DetailOption } from "./catalog";

export type Choice = { key: string; en: string };

/**
 * The rotary files a canal is shaped with, size/taper, as the dentist asked
 * for them (2026-10-15): tapped, as many as were used on that canal.
 */
export const FILE_SIZES = ["20/.04", "20/.06", "25/.04", "25/.06", "30/.04", "30/.06"] as const;

/** A canal's files, as stored ("20/.04, 25/.06"), back into the list. */
export function filesOf(file: string | undefined): string[] {
  return (file ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type StepField =
  /** One row per canal: what the step measures on each. */
  | { kind: "canals"; columns: ("length" | "ref" | "file")[] }
  /** One row per implant: where, which, how big, how tight. */
  | { kind: "implants" }
  | { kind: "choice"; key: string; en: string; options: Choice[]; multi?: boolean }
  | { kind: "text"; key: string; en: string; placeholder?: string }
  /**
   * The treatment's own detail, chosen at this step: a crown's type at its
   * preparation. Its options are the treatment's (catalog.ts), and choosing
   * one sets the treatment's detail too — which is what prices it and names
   * it on the invoice.
   */
  | { kind: "detail"; key: "material"; en: string };

export type StepDef = {
  key: string;
  en: string;
  /** Not needed for the treatment to be finished. */
  optional?: boolean;
  /** Recorded as often as it happens: a medicament change, a healing review. */
  repeatable?: boolean;
  /**
   * No longer offered: kept so the treatments that recorded it still show it.
   * Irrigation went on 2026-10-15 — "the irrigation is in every step".
   */
  retired?: boolean;
  fields?: StepField[];
  /**
   * On a full arch: which of its teeth this step finishes. Placing the
   * implants finishes the implant teeth (and the extractions, which happen at
   * that surgery if not before); delivering the bridge finishes the bridge.
   */
  finishes?: ("implants" | "extractions" | "bridge")[];
};

const IMPRESSION: StepField = {
  kind: "choice",
  key: "impression",
  en: "Impression",
  options: [
    { key: "digital", en: "Digital scan" },
    { key: "conventional", en: "Conventional" },
  ],
};

const RCT_STEPS: StepDef[] = [
  { key: "access", en: "Access cavity" },
  {
    key: "length",
    en: "Working length",
    fields: [
      { kind: "canals", columns: ["length", "ref"] },
      {
        kind: "choice",
        key: "method",
        en: "Measured with",
        options: [
          { key: "apex", en: "Apex locator" },
          { key: "xray", en: "X-ray" },
          { key: "both", en: "Both" },
        ],
      },
    ],
  },
  {
    key: "shaping",
    en: "Cleaning & shaping",
    fields: [
      { kind: "canals", columns: ["file"] },
      {
        kind: "choice",
        key: "system",
        en: "Files",
        options: [
          { key: "rotary", en: "Rotary" },
          { key: "reciprocating", en: "Reciprocating" },
          { key: "hand", en: "Hand files" },
        ],
      },
    ],
  },
  {
    key: "irrigation",
    en: "Irrigation",
    optional: true,
    retired: true,
    fields: [
      {
        kind: "choice",
        key: "irrigants",
        en: "Irrigants",
        multi: true,
        options: [
          { key: "naocl25", en: "NaOCl 2.5%" },
          { key: "naocl525", en: "NaOCl 5.25%" },
          { key: "edta", en: "EDTA 17%" },
          { key: "chx", en: "CHX 2%" },
          { key: "saline", en: "Saline" },
        ],
      },
      {
        kind: "choice",
        key: "activation",
        en: "Activation",
        options: [
          { key: "ultrasonic", en: "Ultrasonic" },
          { key: "sonic", en: "Sonic" },
          { key: "none", en: "None" },
        ],
      },
    ],
  },
  {
    key: "dressing",
    en: "Intracanal medicament",
    optional: true,
    repeatable: true,
    fields: [
      {
        kind: "choice",
        key: "medicament",
        en: "Medicament",
        options: [
          { key: "caoh", en: "Calcium hydroxide" },
          { key: "ledermix", en: "Ledermix" },
          { key: "tap", en: "Triple antibiotic paste" },
        ],
      },
      {
        kind: "choice",
        key: "seal",
        en: "Temporary seal",
        options: [
          { key: "cavit", en: "Cavit" },
          { key: "gic", en: "Glass ionomer" },
          { key: "irm", en: "IRM" },
        ],
      },
    ],
  },
  {
    key: "obturation",
    en: "Obturation",
    fields: [
      {
        kind: "choice",
        key: "technique",
        en: "Technique",
        options: [
          { key: "lateral", en: "Lateral condensation" },
          { key: "warm", en: "Warm vertical" },
          { key: "single", en: "Single cone" },
          { key: "carrier", en: "Carrier-based" },
        ],
      },
      {
        kind: "choice",
        key: "sealer",
        en: "Sealer",
        options: [
          { key: "resin", en: "AH Plus (resin)" },
          { key: "bioceramic", en: "Bioceramic" },
          { key: "zoe", en: "Zinc oxide eugenol" },
        ],
      },
    ],
  },
  {
    key: "restoration",
    en: "Final restoration",
    optional: true,
    fields: [
      {
        kind: "choice",
        key: "restoration",
        en: "Restored with",
        options: [
          { key: "temporary", en: "Temporary filling" },
          { key: "composite", en: "Composite" },
          { key: "core", en: "Core build-up" },
          { key: "post", en: "Post & core" },
        ],
      },
    ],
  },
];

const PLACEMENT_FIELDS: StepField[] = [
  { kind: "implants" },
  {
    kind: "choice",
    key: "stage",
    en: "Healing",
    options: [
      { key: "one", en: "One-stage" },
      { key: "two", en: "Two-stage (covered)" },
    ],
  },
  {
    kind: "choice",
    key: "graft",
    en: "Grafting",
    options: [
      { key: "none", en: "None" },
      { key: "bone", en: "Bone graft" },
      { key: "membrane", en: "Bone graft & membrane" },
    ],
  },
];

/** A crown, a veneer or an inlay, step by step — its type chosen at the preparation, where the dentist decides it. */
const indirectSteps = (typeLabel: string): StepDef[] => [
  {
    key: "prep",
    en: "Preparation & impression",
    fields: [{ kind: "detail", key: "material", en: typeLabel }, IMPRESSION, { kind: "text", key: "shade", en: "Shade", placeholder: "A2" }],
  },
  { key: "temp", en: "Temporary", optional: true },
  { key: "tryin", en: "Try-in", optional: true },
  {
    key: "cement",
    en: "Cementation",
    fields: [
      {
        kind: "choice",
        key: "cement",
        en: "Cement",
        options: [
          { key: "resin", en: "Resin" },
          { key: "gic", en: "Glass ionomer" },
          { key: "zinc", en: "Zinc phosphate" },
          { key: "temporary", en: "Temporary cement" },
        ],
      },
    ],
  },
];
const CROWN_STEPS = indirectSteps("Crown type");
const VENEER_STEPS = indirectSteps("Veneer type");
const INLAY_STEPS = indirectSteps("Material");

const DENTURE_STEPS: StepDef[] = [
  { key: "primary", en: "Primary impression", optional: true },
  { key: "final", en: "Final impression" },
  { key: "bite", en: "Jaw relation (bite)" },
  { key: "tryin", en: "Try-in", optional: true },
  { key: "delivery", en: "Delivery", finishes: ["bridge"] },
  { key: "adjust", en: "Adjustment", optional: true, repeatable: true },
];

export const PROTOCOLS: Record<string, StepDef[]> = {
  rct: RCT_STEPS,
  rct_retreat: [
    {
      key: "removal",
      en: "Removal of old root filling",
      fields: [
        {
          kind: "choice",
          key: "method",
          en: "Removed with",
          options: [
            { key: "rotary", en: "Rotary" },
            { key: "solvent", en: "Solvent" },
            { key: "ultrasonic", en: "Ultrasonic" },
          ],
        },
      ],
    },
    ...RCT_STEPS,
  ],
  pulpectomy: [
    { key: "access", en: "Access cavity" },
    { key: "shaping", en: "Cleaning & shaping" },
    {
      key: "obturation",
      en: "Obturation",
      fields: [
        {
          kind: "choice",
          key: "material",
          en: "Material",
          options: [
            { key: "metapex", en: "Metapex" },
            { key: "zoe", en: "Zinc oxide eugenol" },
            { key: "vitapex", en: "Vitapex" },
          ],
        },
      ],
    },
  ],
  implant: [
    { key: "planning", en: "CBCT & planning", optional: true },
    { key: "placement", en: "Implant placement", fields: PLACEMENT_FIELDS },
    { key: "healing", en: "Healing review", optional: true, repeatable: true },
    { key: "uncovering", en: "Second stage (healing abutment)", optional: true },
  ],
  implant_crown: [
    { key: "impression", en: "Impression / scan", fields: [{ kind: "detail", key: "material", en: "Crown type" }, IMPRESSION] },
    {
      key: "abutment",
      en: "Abutment",
      optional: true,
      fields: [
        {
          kind: "choice",
          key: "abutment",
          en: "Abutment",
          options: [
            { key: "stock", en: "Stock" },
            { key: "custom", en: "Custom" },
            { key: "multiunit", en: "Multi-unit" },
          ],
        },
      ],
    },
    { key: "tryin", en: "Try-in", optional: true },
    {
      key: "delivery",
      en: "Crown delivery",
      fields: [
        {
          kind: "choice",
          key: "retention",
          en: "Retention",
          options: [
            { key: "screw", en: "Screw-retained" },
            { key: "cement", en: "Cement-retained" },
          ],
        },
      ],
    },
  ],
  implant_denture: [
    { key: "planning", en: "CBCT & planning", optional: true },
    { key: "extraction", en: "Extractions & bone levelling", optional: true, finishes: ["extractions"] },
    { key: "placement", en: "Implants placed", fields: PLACEMENT_FIELDS.filter((f) => f.kind !== "choice" || f.key !== "stage"), finishes: ["extractions", "implants"] },
    { key: "temporary", en: "Immediate temporary bridge", optional: true },
    { key: "healing", en: "Healing review", optional: true, repeatable: true },
    { key: "impression", en: "Final impression & bite", fields: [IMPRESSION] },
    { key: "tryin", en: "Try-in", optional: true },
    {
      key: "delivery",
      en: "Final bridge delivery",
      finishes: ["bridge"],
      fields: [
        {
          kind: "choice",
          key: "material",
          en: "Bridge",
          options: [
            { key: "zirconia", en: "Zirconia" },
            { key: "acrylic", en: "Acrylic on titanium" },
            { key: "pmma", en: "PMMA" },
            { key: "peek", en: "PEEK" },
          ],
        },
      ],
    },
  ],
  denture_complete: DENTURE_STEPS,
  denture_partial: DENTURE_STEPS.map((s) => ({ ...s, finishes: undefined })),
  crown: CROWN_STEPS,
  bridge: CROWN_STEPS,
  veneer: VENEER_STEPS,
  hollywood_smile: VENEER_STEPS,
  inlay: INLAY_STEPS,
  onlay: INLAY_STEPS,
  scaling: [
    { key: "upper", en: "Upper arch scaled" },
    { key: "lower", en: "Lower arch scaled" },
    { key: "polish", en: "Polishing" },
    { key: "fluoride", en: "Fluoride", optional: true },
    { key: "ohi", en: "Oral hygiene instruction", optional: true },
  ],
};

/** The step an emergency visit is recorded as on a treatment under way. It never moves the treatment on. */
export const EMERGENCY_STEP = "emergency";

/** What an emergency visit can be: one tap each, as many as were done. */
export const EMERGENCY_ACTIONS = ["pain", "opening", "incision", "temp", "recement", "dressing", "extraction", "rx"] as const;
export type EmergencyAction = (typeof EMERGENCY_ACTIONS)[number];

export function protocolFor(treatmentKey: string): StepDef[] | null {
  return PROTOCOLS[treatmentKey] ?? null;
}

export function stepOf(treatmentKey: string, step: string): StepDef | null {
  return protocolFor(treatmentKey)?.find((s) => s.key === step) ?? null;
}

/** A step as recorded: who, when, at which visit, with what. */
export type StepRecord = {
  id: string;
  markId: string;
  step: string;
  data: StepData;
  note: string;
  performedBy: { id: string; name: string } | null;
  recordedBy: { id: string; name: string };
  appointmentId: string | null;
  doneAt: string;
  voidedAt: string | null;
  voidedBy: { id: string; name: string } | null;
  voidReason: string | null;
};

export type CanalRow = { name: string; length?: number | null; ref?: string; file?: string };
export type ImplantRow = { site: string; system?: string; diameter?: number | null; length?: number | null; torque?: number | null; lot?: string };
export type StepData = {
  canals?: CanalRow[];
  implants?: ImplantRow[];
  /** An emergency's: what was done, and what brought them in. */
  done?: string[];
  complaint?: string;
  [choice: string]: unknown;
};

export type Progress = {
  steps: StepDef[];
  /** Step key → its live records, oldest first. */
  done: Map<string, StepRecord[]>;
  required: number;
  requiredDone: number;
  /** The step to do next: after the last one done, the first still to do. Null once nothing is left. */
  next: StepDef | null;
  /** Every required step is recorded. */
  complete: boolean;
  /** When the first step was recorded: the treatment is under way from then. */
  startedAt: string | null;
  emergencies: number;
};

export function progressOf(treatmentKey: string, records: StepRecord[]): Progress | null {
  const all = protocolFor(treatmentKey);
  if (!all) return null;
  const live = records.filter((r) => !r.voidedAt).sort((a, b) => Date.parse(a.doneAt) - Date.parse(b.doneAt));
  const done = new Map<string, StepRecord[]>();
  for (const r of live) done.set(r.step, [...(done.get(r.step) ?? []), r]);
  // A retired step shows only where it was recorded.
  const steps = all.filter((s) => !s.retired || done.has(s.key));
  const required = steps.filter((s) => !s.optional);
  const requiredDone = required.filter((s) => done.has(s.key)).length;
  // Forward from the furthest step recorded; a repeatable step is never "next" on its own account.
  const last = steps.reduce((i, s, idx) => (done.has(s.key) && !s.repeatable ? idx : i), -1);
  const next =
    steps.find((s, idx) => idx > last && !done.has(s.key) && !s.repeatable) ??
    required.find((s) => !done.has(s.key)) ??
    null;
  return {
    steps,
    done,
    required: required.length,
    requiredDone,
    next,
    complete: requiredDone === required.length,
    startedAt: live.find((r) => r.step !== EMERGENCY_STEP)?.doneAt ?? null,
    emergencies: live.filter((r) => r.step === EMERGENCY_STEP).length,
  };
}

/**
 * The canals of a tooth, named the way dentists name them, for a canal count.
 * An upper molar with three is MB, DB and P; with four, MB1 and MB2. Every
 * name can be changed on the step — anatomy does not read the textbook.
 */
export function canalNames(t: Tooth | null, count: number): string[] {
  const n = Math.max(1, Math.min(4, count || 1));
  if (!t || n === 1) return n === 1 ? ["C"] : Array.from({ length: n }, (_, i) => `C${i + 1}`);
  const upper = t.arch === "upper";
  if (t.kind === "molar") {
    if (upper) return n === 2 ? ["B", "P"] : n === 3 ? ["MB", "DB", "P"] : ["MB1", "MB2", "DB", "P"];
    return n === 2 ? ["M", "D"] : n === 3 ? ["MB", "ML", "D"] : ["MB", "ML", "DB", "DL"];
  }
  if (t.kind === "premolar") {
    if (n === 2) return upper ? ["B", "P"] : ["B", "L"];
    return n === 3 ? ["MB", "DB", upper ? "P" : "L"] : ["MB", "DB", "ML", "DL"];
  }
  return n === 2 ? ["B", upper ? "P" : "L"] : Array.from({ length: n }, (_, i) => `C${i + 1}`);
}

/** Where the working length is measured from, by default: a cusp on a back tooth, the edge on a front one. */
export function defaultReference(t: Tooth | null, canal: string): string {
  if (!t || t.kind === "incisor" || t.kind === "canine") return "Incisal edge";
  const cusp = canal.replace(/\d+$/, "");
  return cusp === "C" ? "Cusp tip" : `${cusp} cusp`;
}

/** "MB 21 · DB 20.5 · P 22 mm": a step's canals in one line. */
export function canalSummary(rows: CanalRow[] | undefined, column: "length" | "file"): string {
  if (!rows?.length) return "";
  const parts = rows
    .map((r) => (column === "length" ? (r.length != null ? `${r.name} ${r.length}` : "") : filesOf(r.file).length ? `${r.name} ${filesOf(r.file).join(" + ")}` : ""))
    .filter(Boolean);
  if (!parts.length) return "";
  return column === "length" ? `${parts.join(" · ")} mm` : parts.join(" · ");
}

/** The options of a treatment's own detail — a crown's types — or none. */
export function detailOptions(treatmentKey: string, key: string): DetailOption[] {
  return BUILT_IN_BY_KEY.get(treatmentKey)?.details?.find((d) => d.key === key)?.options ?? [];
}

/** One line for what a step recorded: canal lengths, the choices made, the implants placed. */
export function stepSummary(def: StepDef | null, data: StepData, treatmentKey = ""): string {
  if (!def) return [data.complaint, ...(data.done ?? [])].filter(Boolean).join(" · ");
  const out: string[] = [];
  for (const f of def.fields ?? []) {
    if (f.kind === "detail") {
      const v = data[f.key];
      const o = typeof v === "string" ? detailOptions(treatmentKey, f.key).find((x) => x.key === v) : undefined;
      if (o) out.push(o.en);
    } else if (f.kind === "canals") {
      if (f.columns.includes("length")) out.push(canalSummary(data.canals, "length"));
      if (f.columns.includes("file")) out.push(canalSummary(data.canals, "file"));
    } else if (f.kind === "implants") {
      for (const i of data.implants ?? []) {
        const size = i.diameter && i.length ? `${i.diameter}×${i.length}` : "";
        out.push([i.site, i.system, size, i.torque ? `${i.torque} Ncm` : ""].filter(Boolean).join(" "));
      }
    } else if (f.kind === "choice") {
      const v = data[f.key];
      const keys = Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
      const names = keys.map((k) => f.options.find((o) => o.key === k)?.en).filter(Boolean);
      if (names.length) out.push(names.join(", "));
    } else if (f.kind === "text") {
      const v = data[f.key];
      if (typeof v === "string" && v.trim()) out.push(`${f.en} ${v.trim()}`);
    }
  }
  return out.filter(Boolean).join(" · ");
}

/** What usually comes after a treatment is finished — the next steps the doctor asked to see. */
export const FOLLOW_UPS: Record<string, string[]> = {
  rct: ["crown", "core_buildup", "post_core"],
  rct_retreat: ["crown", "core_buildup"],
  implant: ["implant_crown"],
  extraction: ["implant", "bridge"],
  extraction_surgical: ["implant", "bridge"],
};
