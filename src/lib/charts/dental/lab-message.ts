/**
 * The lab order in words: the message the clinic sends its lab on WhatsApp,
 * and the rows of the printed order (2026-11-26).
 *
 * English, like the chart and like a lab's own vocabulary; the patient's name
 * is as the clinic wrote it. It says what the lab needs to make the work and
 * nothing more of the patient: no phone number, no medical history, no money.
 */

import { fmtDateOnly } from "@/lib/dates";
import { EVERY_TOOTH } from "./full-arch";
import { LAB_TRIPS, orderRef, type LabCase, type LabSpec } from "./labs";
import { detailOptions } from "./protocols";

export type OrderWords = {
  title: string;
  patient: string;
  work: string;
  tooth: string;
  teeth: string;
  supports: string;
  replaced: string;
  implants: string;
  onImplant: string;
  material: string;
  stage: string;
  stages: Record<string, string>;
  shade: string;
  due: string;
  note: string;
  pdf: string;
  upper: string;
  lower: string;
};

export type OrderOf = {
  /** What the chart calls the work: "Bridge", "Zirconia crown". */
  work: string;
  /** Where it is: a tooth, or "upper" / "lower" for a full arch. */
  site: string;
  treatmentKey: string;
  /** The material on the chart, for an order sent before it kept one. */
  material?: string | null;
};

const TOOTH = /^[1-8][1-8]$/;
const inOrder = (sites: string[]) => [...sites].sort((a, b) => EVERY_TOOTH.indexOf(a) - EVERY_TOOTH.indexOf(b));

export function materialName(treatmentKey: string, key: string | null | undefined): string | null {
  if (!key) return null;
  return detailOptions(treatmentKey, "material").find((o) => o.key === key)?.en ?? key;
}

/** The order's facts, label and value, in the order a lab reads them. */
export function orderRows(c: Pick<LabCase, "spec" | "stage" | "shade" | "dueOn" | "note">, o: OrderOf, W: OrderWords): [string, string][] {
  const spec: LabSpec = c.spec ?? {};
  const teeth = spec.teeth ?? [];
  const arch = !TOOTH.test(o.site);
  const by = (role: "abutment" | "pontic") => teeth.filter((x) => x.role === role).map((x) => (x.implant ? `${x.site} (${W.onImplant})` : x.site));
  const rows: [string, string][] = [];
  if (arch) rows.push([W.teeth, o.site === "lower" ? W.lower : W.upper]);
  else if (teeth.length > 1) {
    rows.push([W.teeth, inOrder(teeth.map((x) => x.site)).join(" · ")]);
    if (by("abutment").length) rows.push([W.supports, by("abutment").join(" · ")]);
    if (by("pontic").length) rows.push([W.replaced, by("pontic").join(" · ")]);
  } else rows.push([W.tooth, teeth[0]?.site ?? o.site]);
  const implants = spec.implants ?? [];
  if (implants.length) {
    rows.push([W.implants, implants.map((i) => [i.site, i.system, i.diameter && i.length ? `Ø${i.diameter} × ${i.length} mm` : ""].filter(Boolean).join(" ")).join(" · ")]);
  }
  const material = materialName(o.treatmentKey, spec.material ?? o.material);
  if (material) rows.push([W.material, material]);
  if (LAB_TRIPS[o.treatmentKey]) rows.push([W.stage, W.stages[c.stage] ?? c.stage]);
  if (c.shade) rows.push([W.shade, c.shade]);
  if (c.dueOn) rows.push([W.due, fmtDateOnly(c.dueOn, "en")]);
  if (c.note) rows.push([W.note, c.note]);
  return rows;
}

/** The WhatsApp message: the order, and the link to its PDF. */
export function orderMessage(c: LabCase, o: OrderOf & { clinic: string; patient: string }, W: OrderWords): string {
  const lines = [
    `*${W.title} ${orderRef(c.id)}* · ${o.clinic}`,
    `${W.patient}: ${o.patient}`,
    `${W.work}: ${o.work}`,
    ...orderRows(c, o, W).map(([k, v]) => `${k}: ${v}`),
  ];
  if (c.orderUrl) lines.push("", `${W.pdf}: ${c.orderUrl}`);
  return lines.join("\n");
}

/**
 * A WhatsApp chat with the lab, the message written. Without a number the app
 * opens on its list of chats, to choose the lab from.
 */
export function whatsAppLink(e164: string | null, text: string): string {
  const to = e164 ? e164.replace(/\D/g, "") : "";
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
