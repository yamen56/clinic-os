/**
 * Vital signs on the visit record (migration 0125).
 *
 * Numbers by name, absent until measured. Imported by the record sheet in the
 * browser and by the save route, so nothing here reaches for a Node module.
 *
 * The "usual" ranges are an adult's resting ones and only colour a number for
 * a second look. They are not a diagnosis, and a child's are different —
 * which is why the sheet says "outside the usual adult range" and nothing more.
 */

export const VITAL_KEYS = ["bp_sys", "bp_dia", "pulse", "temp", "spo2", "weight", "height", "sugar"] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];
export type Vitals = Partial<Record<VitalKey, number>>;

type Spec = {
  /** What may be typed at all: beyond this it is a typo, not a reading. */
  min: number;
  max: number;
  /** Decimals kept. */
  dp: 0 | 1;
  unit: string;
  /** The usual adult resting range, for colouring only. */
  usual?: [number, number];
};

export const VITAL_SPECS: Record<VitalKey, Spec> = {
  bp_sys: { min: 40, max: 300, dp: 0, unit: "mmHg", usual: [90, 139] },
  bp_dia: { min: 20, max: 200, dp: 0, unit: "mmHg", usual: [60, 89] },
  pulse: { min: 20, max: 250, dp: 0, unit: "/min", usual: [50, 100] },
  temp: { min: 30, max: 45, dp: 1, unit: "°C", usual: [35, 37.9] },
  spo2: { min: 50, max: 100, dp: 0, unit: "%", usual: [94, 100] },
  weight: { min: 0.3, max: 400, dp: 1, unit: "kg" },
  height: { min: 20, max: 250, dp: 0, unit: "cm" },
  sugar: { min: 10, max: 1000, dp: 0, unit: "mg/dL", usual: [70, 199] },
};

const round = (n: number, dp: 0 | 1) => (dp ? Math.round(n * 10) / 10 : Math.round(n));

/**
 * What a typed value means: a number to keep, null to clear, or "bad" for
 * something that is not a reading. Arabic-Indic digits and a comma for the
 * decimal point are read as a phone keyboard types them.
 */
export function readVital(key: VitalKey, raw: string): number | null | "bad" {
  const s = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[٫,]/g, ".");
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return "bad";
  const spec = VITAL_SPECS[key];
  const n = round(Number(s), spec.dp);
  return n < spec.min || n > spec.max ? "bad" : n;
}

/**
 * A patch from the browser, made safe: known keys only, each a number in
 * range or null (cleared). Anything else refuses the whole patch.
 */
export function cleanVitalsPatch(raw: unknown): Record<string, number | null> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(VITAL_KEYS as readonly string[]).includes(k)) return null;
    if (v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const spec = VITAL_SPECS[k as VitalKey];
    const n = round(v, spec.dp);
    if (n < spec.min || n > spec.max) return null;
    out[k] = n;
  }
  return out;
}

/** What is stored, read back defensively: a hand-edited row cannot break the sheet. */
export function asVitals(raw: unknown): Vitals {
  const out: Vitals = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of VITAL_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export const hasVitals = (v: Vitals | null | undefined) => !!v && VITAL_KEYS.some((k) => v[k] !== undefined);

/** Body mass index from weight and height, one decimal; null without both. */
export function bmi(v: Vitals): number | null {
  if (!v.weight || !v.height) return null;
  const m = v.height / 100;
  return Math.round((v.weight / (m * m)) * 10) / 10;
}

/** Whether a reading is outside the usual adult resting range. */
export function unusual(key: VitalKey, n: number | undefined): boolean {
  const u = VITAL_SPECS[key].usual;
  return n !== undefined && !!u && (n < u[0] || n > u[1]);
}

export type VitalLabels = {
  bp: string;
  pulse: string;
  temp: string;
  spo2: string;
  weight: string;
  height: string;
  sugar: string;
  bmi: string;
};

/** One reading, as a line of label–value pairs, for the record and the card. */
export function vitalParts(v: Vitals, L: VitalLabels): { key: string; label: string; value: string; unusual: boolean }[] {
  const parts: { key: string; label: string; value: string; unusual: boolean }[] = [];
  if (v.bp_sys !== undefined || v.bp_dia !== undefined) {
    parts.push({
      key: "bp",
      label: L.bp,
      value: `${v.bp_sys ?? "–"}/${v.bp_dia ?? "–"}`,
      unusual: unusual("bp_sys", v.bp_sys) || unusual("bp_dia", v.bp_dia),
    });
  }
  const one = (k: Exclude<VitalKey, "bp_sys" | "bp_dia">, label: string) => {
    if (v[k] === undefined) return;
    const unit = VITAL_SPECS[k].unit;
    parts.push({ key: k, label, value: `${v[k]}${unit === "%" || unit === "°C" ? unit : ` ${unit}`}`, unusual: unusual(k, v[k]) });
  };
  one("pulse", L.pulse);
  one("temp", L.temp);
  one("spo2", L.spo2);
  one("sugar", L.sugar);
  one("weight", L.weight);
  one("height", L.height);
  const b = bmi(v);
  if (b !== null) parts.push({ key: "bmi", label: L.bmi, value: String(b), unusual: false });
  return parts;
}
