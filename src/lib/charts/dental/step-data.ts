/**
 * What the server accepts as a step's data: only the fields the step has,
 * each within the bounds a mouth allows. A canal is not 300 mm long, and a
 * step cannot smuggle in keys the protocol never asked for — anything else is
 * dropped before it is stored.
 */

import { z } from "zod";
import { EMERGENCY_ACTIONS, detailOptions, type StepDef, type StepData } from "./protocols";

const canal = z.object({
  name: z.string().trim().min(1).max(8),
  length: z.number().min(0).max(60).nullable().optional(),
  ref: z.string().trim().max(40).optional(),
  // The files used on it, "20/.04, 25/.06": every size on the list fits.
  file: z.string().trim().max(80).optional(),
});

const implant = z.object({
  site: z.string().regex(/^[1-8][1-8]$/),
  system: z.string().trim().max(40).optional(),
  diameter: z.number().min(0).max(10).nullable().optional(),
  length: z.number().min(0).max(30).nullable().optional(),
  torque: z.number().min(0).max(120).nullable().optional(),
  lot: z.string().trim().max(40).optional(),
});

const emergency = z.object({
  done: z.array(z.enum(EMERGENCY_ACTIONS)).max(EMERGENCY_ACTIONS.length).default([]),
  complaint: z.string().trim().max(300).default(""),
});

/**
 * The data a step may carry, or null when it is not acceptable. `def` null is
 * an emergency visit. `treatmentKey` gives a detail field (a crown's type) its
 * options: the treatment's own.
 */
export function parseStepData(def: StepDef | null, raw: unknown, treatmentKey = ""): StepData | null {
  if (!def) {
    const r = emergency.safeParse(raw ?? {});
    return r.success ? r.data : null;
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of def.fields ?? []) {
    if (f.kind === "canals") shape.canals = z.array(canal).max(6).optional();
    else if (f.kind === "implants") shape.implants = z.array(implant).max(10).optional();
    else if (f.kind === "choice") {
      const keys = f.options.map((o) => o.key) as [string, ...string[]];
      shape[f.key] = f.multi ? z.array(z.enum(keys)).max(keys.length).optional() : z.enum(keys).optional();
    } else if (f.kind === "detail") {
      const keys = detailOptions(treatmentKey, f.key).map((o) => o.key);
      if (keys.length) shape[f.key] = z.enum(keys as [string, ...string[]]).optional();
    } else if (f.kind === "text") shape[f.key] = z.string().trim().max(60).optional();
  }
  const r = z.object(shape).strip().safeParse(raw ?? {});
  return r.success ? (r.data as StepData) : null;
}
