/*
  What every drawing on the dental chart is built from: the column a tooth is
  drawn in and its landmarks, where its pictures are, the gum's edge, the inks
  a status is drawn in and the materials work is made of. Kept apart so a tooth
  (tooth-art.tsx) and a prosthesis (prosthesis-art.tsx) can each draw the other
  without importing it.
*/

import type { Tooth } from "@/lib/charts/dental/teeth";
import type { Layer, Paint } from "@/lib/charts/dental/state";

export const CW = 44;
export const SIDE_H = 104;
export const OCC = 44;

export const C = 22;
export const Y0 = 62; // the neck: where enamel meets root, and where the gum sits
export const YB = 74; // the widest point of the crown
export const YE = 100; // the biting edge

/** Gradient ids live once per page, in `<DentalDefs />`. */
export const DEFS = "dental-defs";

export const INK: Record<Paint, string> = {
  planned: "var(--color-dental-planned)",
  done: "var(--color-dental-done)",
  existing: "var(--color-dental-existing)",
  finding: "var(--color-dental-finding)",
  progress: "var(--color-dental-progress)",
};
export const SOFT: Record<Paint, string> = {
  planned: "var(--color-dental-planned-soft)",
  done: "var(--color-dental-done-soft)",
  existing: "var(--color-dental-existing-soft)",
  finding: "var(--color-dental-finding-soft)",
  progress: "var(--color-dental-progress-soft)",
};

export const LINE = "var(--color-tooth-line)";
export const url = (id: string) => `url(#${DEFS}-${id})`;

/*
  The baked art (scripts/render-tooth-art.tsx → public/charts/teeth): one
  picture per drawing, named by what decides its shape. A baby tooth's incisors
  and canines share the grown-up drawing, as `shapeOf` does; its molars do not.
*/
export function sideArtKey(t: Tooth): string {
  const a = t.arch === "upper" ? "u" : "l";
  if (t.kind === "incisor") return `${a}-i${t.position === 1 ? 1 : 2}`;
  if (t.kind === "canine") return `${a}-c`;
  if (t.kind === "premolar") return `${a}-p`;
  return t.primary ? `${a}-d${t.position === 4 ? 4 : 5}` : `${a}-m${t.position}`;
}
export function topArtKey(t: Tooth): string {
  const a = t.arch === "upper" ? "u" : "l";
  if (t.kind === "incisor") return a === "u" ? `u-i${t.position === 1 ? 1 : 2}` : "l-i";
  if (t.kind === "canine") return `${a}-c`;
  if (t.kind === "premolar") return `${a}-p`;
  return t.primary ? `${a}-d` : `${a}-m${t.position}`;
}
/** Bump when the art is baked again, so a browser never paints yesterday's picture. */
export const ART_VERSION = 3;
/** How far each column's gum reaches into its neighbours', so the joint never shows (the renderer explains). */
export const GUM_PAD = 0.6;
export const sideArt = (t: Tooth) => `/charts/teeth/side-${sideArtKey(t)}.webp?v=${ART_VERSION}`;
export const topArt = (t: Tooth) => `/charts/teeth/top-${topArtKey(t)}.webp?v=${ART_VERSION}`;
export const gumArt = (t: Tooth) => `/charts/teeth/gum-${t.arch === "upper" ? "u" : "l"}.webp?v=${ART_VERSION}`;
/** Healed gum where a tooth is gone: level on a side whose neighbour is gone too, rising to the papilla where it stands. */
export const ridgeArt = (t: Tooth, leftGone: boolean, rightGone: boolean) =>
  `/charts/teeth/ridge-${t.arch === "upper" ? "u" : "l"}-${leftGone ? 1 : 0}${rightGone ? 1 : 0}.webp?v=${ART_VERSION}`;

/*
  The gingiva: coral tissue over the neck, a papilla rising between each pair
  of teeth and a lighter rim at the margin, fading up the root so what is done
  in the roots stays visible. Drawn per tooth, so it tiles across the arch.
*/
export const GUM_TOP = Y0 - 34;
export const PAP = Y0 + 11; // the papilla's tip, between two crowns
export const ZEN = Y0 + 1; // the margin's highest point, over the middle of the tooth
/*
  The papilla's tips sit level at the column's edges, so the halves drawn by
  two neighbours meet in one smooth round. Exactly its column wide: tissue
  drawn half-transparent shows a darker line wherever two pieces overlap.
*/
export function gumPath(): string {
  return festoon(GUM_TOP);
}
/** Tissue from `top` down to the gingival margin, festooned round the neck — the gum, or a denture's acrylic. */
export function festoon(top: number): string {
  return (
    `M 0 ${top} L ${CW} ${top} L ${CW} ${PAP} ` +
    `C ${CW - 2.2} ${PAP} ${CW - 4.2} ${PAP - 1.6} ${CW - 6} ${PAP - 4} C ${CW - 9} ${ZEN + 3} ${C + 8} ${ZEN} ${C} ${ZEN} ` +
    `C ${C - 8} ${ZEN} 9 ${ZEN + 3} 6 ${PAP - 4} C 4.2 ${PAP - 1.6} 2.2 ${PAP} 0 ${PAP} Z`
  );
}
export function gumMargin(): string {
  return `M 0 ${PAP} C 2.2 ${PAP} 4.2 ${PAP - 1.6} 6 ${PAP - 4} C 9 ${ZEN + 3} ${C - 8} ${ZEN} ${C} ${ZEN} C ${C + 8} ${ZEN} ${CW - 9} ${ZEN + 3} ${CW - 6} ${PAP - 4} C ${CW - 4.2} ${PAP - 1.6} ${CW - 2.2} ${PAP} ${CW} ${PAP}`;
}

export type Material =
  | "ceramic"
  | "metal"
  | "gold"
  | "composite"
  | "amalgam"
  | "gic"
  | "temp"
  | "titanium"
  | "gutta"
  | "mta"
  | "acrylic"
  | "zirconia"
  | "peek"
  | "porcelain"
  | "dentin";

/** What a piece of work is made of: from the material chosen, else from the treatment. */
export function materialOf(l: Layer): Material {
  const m = l.detail.material;
  if (m === "metal") return "metal";
  if (m === "gold") return "gold";
  if (m === "temporary") return "temp";
  if (m === "amalgam") return "amalgam";
  if (m === "gic") return "gic";
  if (m === "composite") return l.look === "filling" ? "composite" : "ceramic";
  if (m === "zirconia" || m === "emax" || m === "ceramic" || m === "porcelain" || m === "pfm") return "ceramic";
  const k = l.treatmentKey ?? "";
  if (k === "filling_amalgam") return "amalgam";
  if (k === "filling_gic") return "gic";
  if (k === "filling_temp") return "temp";
  if (k === "ssc" || k === "post_core") return "metal";
  if (k === "bonding") return "composite";
  if (l.look === "filling" || l.look === "core") return "composite";
  if (l.look === "sealant") return "composite";
  return "ceramic";
}

/** Planned work is a ghost of what it will be; done and existing work is the thing itself. */
export function presence(p: Paint): number {
  return p === "planned" ? 0.5 : p === "progress" ? 0.8 : 1;
}

/** The status, as an edge round the work: dashed red planned, dashed violet under way, a fine blue line done. */
export function edge(p: Paint, w = 1.1): React.CSSProperties & { strokeDasharray?: string } {
  const loud = p === "planned" || p === "progress";
  return {
    stroke: INK[p],
    strokeWidth: loud ? w + 0.35 : w * 0.8,
    strokeDasharray: p === "planned" ? "3 2" : p === "progress" ? "4 1.6" : undefined,
    strokeLinejoin: "round",
  };
}

/** A material's fill. */
export const fillOf = (m: Material) => (m === "mta" ? url("mta") : url(m));

/*
  Each material as a colour matrix over the enamel's picture, from its
  luminance: ceramic a warm porcelain white, composite a touch brighter and
  less yellow than enamel (it reads by its edge, as it does in the mouth),
  metal and amalgam grey with more contrast, gold gold, glass ionomer a matte
  grey-white, a temporary the tan of acrylic.
*/
export const lum = (k: number, add: number) => `${(0.2126 * k).toFixed(4)} ${(0.7152 * k).toFixed(4)} ${(0.0722 * k).toFixed(4)} 0 ${add}`;
export const TINTS: Partial<Record<Material, string>> = {
  ceramic: `${lum(0.92, 0.12)} ${lum(0.92, 0.105)} ${lum(0.92, 0.08)} 0 0 0 1 0`,
  composite: `0.9 0.08 0.02 0 0.03 0.04 0.92 0.04 0 0.03 0.04 0.1 0.86 0 0.07 0 0 0 1 0`,
  metal: `${lum(1.12, -0.3)} ${lum(1.12, -0.29)} ${lum(1.12, -0.25)} 0 0 0 1 0`,
  gold: `${lum(1.05, 0.02)} ${lum(0.88, -0.04)} ${lum(0.55, -0.1)} 0 0 0 1 0`,
  amalgam: `${lum(1.05, -0.42)} ${lum(1.05, -0.41)} ${lum(1.05, -0.38)} 0 0 0 1 0`,
  gic: `${lum(0.75, 0.19)} ${lum(0.75, 0.2)} ${lum(0.75, 0.17)} 0 0 0 1 0`,
  temp: `${lum(0.95, 0.03)} ${lum(0.88, 0.015)} ${lum(0.75, 0)} 0 0 0 1 0`,
  // A bridge's teeth are porcelain already; these bring them to what they are made of.
  zirconia: `${lum(0.97, 0.035)} ${lum(0.96, 0.03)} ${lum(0.94, 0.02)} 0 0 0 1 0`,
  acrylic: `${lum(0.95, 0.035)} ${lum(0.93, 0.015)} ${lum(0.87, -0.005)} 0 0 0 1 0`,
  peek: `${lum(0.84, 0.03)} ${lum(0.76, 0)} ${lum(0.64, -0.03)} 0 0 0 1 0`,
  porcelain: `${lum(0.92, 0.12)} ${lum(0.92, 0.1)} ${lum(0.92, 0.07)} 0 0 0 1 0`,
  // A tooth cut down for a crown: the dentin under the enamel.
  dentin: `${lum(0.92, 0)} ${lum(0.8, -0.02)} ${lum(0.58, -0.02)} 0 0 0 1 0`,
};
/** The tooth's picture in a material: the one filter for it, or none for what has no tint. */
export const tintOf = (m: Material) => (TINTS[m] ? url(`tint-${m}`) : url("tint-ceramic"));

export function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

export function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return `M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
}

/** The chewing surface's half-width and half-height, from above. */
export function topHalf(t: Tooth): [number, number] {
  if (t.kind === "molar") return [(t.primary ? 32 : t.position === 8 ? 34 : t.position === 7 ? 36 : 38) / 2, (t.arch === "upper" ? 35 : 33) / 2];
  if (t.kind === "premolar") return [14.5, 17];
  if (t.kind === "canine") return [14.5, 15.5];
  if (t.arch === "upper") return t.position === 1 ? [17.5, 11.5] : [15, 10.5];
  return [12.5, 10];
}

export function topOutline(t: Tooth): string {
  const c = OCC / 2;
  const [rx, ry] = topHalf(t);
  if (t.kind === "molar") return roundRect(c - rx, c - ry, rx * 2, ry * 2, 11);
  return ellipse(c, c, rx, ry);
}
