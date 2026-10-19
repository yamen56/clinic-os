"use client";

/*
  The drawing of one tooth, twice: from the side (crown, roots and gum) and from
  above (the chewing surface). Everything recorded on the tooth is a layer drawn
  onto these, so a filling fills the surface it was placed on, a root canal runs
  down the roots, an implant replaces them and an extraction leaves a ghost.

  Drawn to look like the mouth (Yamen, 2026-10-19: "realistic … like in the
  true life"): enamel that is warmer at the neck and translucent at the edge,
  dentin-coloured roots, coral gingiva with papillae between the teeth, and
  work in its own material — a zirconia crown is white ceramic, a metal one
  metal, a root canal is gutta-percha, an implant titanium, decay is dark and
  irregular. What the dentist needs to read stays: planned work is a faded
  ghost of the material with a dashed red outline, work under way dashed
  violet, done work solid with a thin blue edge — the red/blue convention
  dentists already read, with a second cue that survives colour blindness and
  a black-and-white printout.

  Geometry is in tooth-local units: a 44-wide column, 104 tall from the root
  apex (y≈5) to the biting edge (y=100), drawn as an upper tooth. A lower tooth
  is the same drawing flipped, so its roots point down and its crown up, the way
  the mouth closes. Colours are the theme's dental tokens; nothing here is a hex.
*/

import { surfaceAt, type Surface, type Tooth } from "@/lib/charts/dental/teeth";
import type { Layer, Paint, ToothState } from "@/lib/charts/dental/state";
import type { Look } from "@/lib/charts/dental/catalog";

export const CW = 44;
export const SIDE_H = 104;
export const OCC = 44;

const C = 22;
const Y0 = 62; // the neck: where enamel meets root, and where the gum sits
const YB = 74; // the widest point of the crown
const YE = 100; // the biting edge

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

const LINE = "var(--color-tooth-line)";
const url = (id: string) => `url(#${DEFS}-${id})`;

type Shape = { nw: number; mw: number; cusp: "incisal" | "canine" | "premolar" | "molar"; apex: number; roots: 1 | 2 | 3 };

/*
  Half-widths at the neck (nw) and at the contact points (mw). Crowns fill most
  of their column so neighbours nearly touch, the way an arch does; the neck is
  about seven tenths of the crown, which is what gives a tooth its waist. Front
  teeth are a little narrower than molars, lower incisors narrowest of all.
*/
export function shapeOf(t: Tooth): Shape {
  const upper = t.arch === "upper";
  if (t.kind === "incisor") {
    if (t.position === 1) return upper ? { nw: 11.5, mw: 17.5, cusp: "incisal", apex: 14, roots: 1 } : { nw: 8, mw: 12.5, cusp: "incisal", apex: 18, roots: 1 };
    return upper ? { nw: 9.5, mw: 15, cusp: "incisal", apex: 18, roots: 1 } : { nw: 8.5, mw: 13.5, cusp: "incisal", apex: 17, roots: 1 };
  }
  if (t.kind === "canine") return upper ? { nw: 10.5, mw: 16, cusp: "canine", apex: 4, roots: 1 } : { nw: 10, mw: 15.5, cusp: "canine", apex: 7, roots: 1 };
  if (t.kind === "premolar") return { nw: upper ? 10.5 : 10, mw: upper ? 16 : 15.5, cusp: "premolar", apex: 13, roots: 1 };
  if (t.primary) return { nw: t.position === 4 ? 12 : 13.5, mw: t.position === 4 ? 17.5 : 19.5, cusp: "molar", apex: 26, roots: upper ? 3 : 2 };
  const p = t.position;
  const w = p === 6 ? { nw: 14.5, mw: 21 } : p === 7 ? { nw: 14, mw: 20.5 } : { nw: 13, mw: 19 };
  return { ...w, cusp: "molar", apex: p === 6 ? 15 : p === 7 ? 18 : 23, roots: upper ? 3 : 2 };
}

function crownPath(s: Shape): string {
  const { nw, mw } = s;
  let d = `M ${C - nw} ${Y0} C ${C - nw - 1.5} ${Y0 + 4} ${C - mw} ${YB - 6} ${C - mw} ${YB}`;
  switch (s.cusp) {
    case "incisal":
      d += ` C ${C - mw} ${YE - 8} ${C - mw + 1} ${YE} ${C - mw + 4} ${YE} L ${C + mw - 4} ${YE} C ${C + mw - 1} ${YE} ${C + mw} ${YE - 8} ${C + mw} ${YB}`;
      break;
    case "canine":
      d += ` C ${C - mw} ${YE - 12} ${C - 5} ${YE - 2} ${C} ${YE + 1} C ${C + 5} ${YE - 2} ${C + mw} ${YE - 12} ${C + mw} ${YB}`;
      break;
    case "premolar":
      d += ` C ${C - mw} ${YE - 9} ${C - 6} ${YE} ${C} ${YE} C ${C + 6} ${YE} ${C + mw} ${YE - 9} ${C + mw} ${YB}`;
      break;
    case "molar":
      d += ` C ${C - mw} ${YE - 6} ${C - mw + 2} ${YE} ${C - mw / 2} ${YE} C ${C - 4} ${YE} ${C - 2.5} ${YE - 3} ${C} ${YE - 3} C ${C + 2.5} ${YE - 3} ${C + 4} ${YE} ${C + mw / 2} ${YE} C ${C + mw - 2} ${YE} ${C + mw} ${YE - 6} ${C + mw} ${YB}`;
      break;
  }
  d += ` C ${C + mw} ${YB - 6} ${C + nw + 1.5} ${Y0 + 4} ${C + nw} ${Y0} Q ${C} ${Y0 - 5} ${C - nw} ${Y0} Z`;
  return d;
}

type Roots = { body: string; back?: string; canals: [number, number, number, number][]; apices: [number, number][]; furcation?: [number, number] };

function rootGeom(s: Shape): Roots {
  const { nw, apex: ya } = s;
  if (s.roots === 1) {
    return {
      body: `M ${C - nw} ${Y0} C ${C - nw + 0.5} ${Y0 - 16} ${C - 3.5} ${ya + 10} ${C - 1} ${ya + 1} Q ${C} ${ya - 1} ${C + 1} ${ya + 1} C ${C + 3.5} ${ya + 10} ${C + nw - 0.5} ${Y0 - 16} ${C + nw} ${Y0} Q ${C} ${Y0 - 5} ${C - nw} ${Y0} Z`,
      canals: [[C, Y0 + 6, C, ya + 5]],
      apices: [[C, ya]],
    };
  }
  const L = C - nw * 0.58;
  const R = C + nw * 0.58;
  const yr = ya + 3;
  const fy = Y0 - 15;
  const body =
    `M ${C - nw} ${Y0} C ${C - nw - 1.2} ${Y0 - 14} ${L - 4} ${ya + 12} ${L - 1.5} ${ya + 1} Q ${L} ${ya - 1} ${L + 1.5} ${ya + 1} ` +
    `C ${L + 3} ${ya + 12} ${C - 2} ${fy - 4} ${C} ${fy} C ${C + 2} ${fy - 4} ${R - 3} ${yr + 12} ${R - 1.5} ${yr + 1} ` +
    `Q ${R} ${yr - 1} ${R + 1.5} ${yr + 1} C ${R + 4} ${yr + 12} ${C + nw + 1.2} ${Y0 - 14} ${C + nw} ${Y0} Q ${C} ${Y0 - 5} ${C - nw} ${Y0} Z`;
  const out: Roots = {
    body,
    canals: [
      [C - 2, Y0 + 4, L, ya + 5],
      [C + 2, Y0 + 4, R, yr + 5],
    ],
    apices: [
      [L, ya],
      [R, yr],
    ],
    furcation: [C, fy],
  };
  if (s.roots === 3) {
    // The palatal root, seen through the two buccal ones: drawn behind and paler.
    const pw = nw * 0.62;
    const pa = ya - 3;
    out.back = `M ${C - pw} ${Y0} C ${C - pw} ${Y0 - 18} ${C - 3} ${pa + 9} ${C} ${pa} C ${C + 3} ${pa + 9} ${C + pw} ${Y0 - 18} ${C + pw} ${Y0} Z`;
    out.canals.push([C, Y0 + 4, C, pa + 5]);
  }
  return out;
}

function chamberPath(s: Shape): string {
  const w = Math.max(3, s.nw * 0.55);
  const top = Y0 - 3;
  const bottom = Y0 + (s.cusp === "molar" ? 13 : 16);
  return `M ${C - w} ${top} Q ${C - w} ${bottom} ${C} ${bottom} Q ${C + w} ${bottom} ${C + w} ${top} Z`;
}

/** A canal filled from the chamber to the apex: wide where it is shaped, fine at the tip. */
function canalPath([x1, y1, x2, y2]: [number, number, number, number], top = 1.7, tip = 0.45): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const p = (x: number, y: number, w: number, side: 1 | -1) => `${x + nx * w * side} ${y + ny * w * side}`;
  return `M ${p(x1, y1, top, 1)} L ${p(x2, y2, tip, 1)} Q ${x2 + (dx / len) * 1.2} ${y2 + (dy / len) * 1.2} ${p(x2, y2, tip, -1)} L ${p(x1, y1, top, -1)} Z`;
}

/*
  The gingiva: coral tissue over the neck, a papilla rising between each pair
  of teeth and a lighter rim at the margin, fading up the root so what is done
  in the roots stays visible. Drawn per tooth, so it tiles across the arch.
*/
const GUM_TOP = Y0 - 34;
const PAP = Y0 + 11; // the papilla's tip, between two crowns
const ZEN = Y0 + 1; // the margin's highest point, over the middle of the tooth
/*
  The papilla's tips sit level at the column's edges, so the halves drawn by
  two neighbours meet in one smooth round. Exactly its column wide: tissue
  drawn half-transparent shows a darker line wherever two pieces overlap.
*/
function gumPath(): string {
  return festoon(GUM_TOP);
}
/** Tissue from `top` down to the gingival margin, festooned round the neck — the gum, or a denture's acrylic. */
function festoon(top: number): string {
  return (
    `M 0 ${top} L ${CW} ${top} L ${CW} ${PAP} ` +
    `C ${CW - 2.2} ${PAP} ${CW - 4.2} ${PAP - 1.6} ${CW - 6} ${PAP - 4} C ${CW - 9} ${ZEN + 3} ${C + 8} ${ZEN} ${C} ${ZEN} ` +
    `C ${C - 8} ${ZEN} 9 ${ZEN + 3} 6 ${PAP - 4} C 4.2 ${PAP - 1.6} 2.2 ${PAP} 0 ${PAP} Z`
  );
}
function gumMargin(): string {
  return `M 0 ${PAP} C 2.2 ${PAP} 4.2 ${PAP - 1.6} 6 ${PAP - 4} C 9 ${ZEN + 3} ${C - 8} ${ZEN} ${C} ${ZEN} C ${C + 8} ${ZEN} ${CW - 9} ${ZEN + 3} ${CW - 6} ${PAP - 4} C ${CW - 4.2} ${PAP - 1.6} ${CW - 2.2} ${PAP} ${CW} ${PAP}`;
}

/* ── Materials ───────────────────────────────────────────────────────────── */

type Material = "ceramic" | "metal" | "gold" | "composite" | "amalgam" | "gic" | "temp" | "titanium" | "gutta" | "mta" | "acrylic";

/** What a piece of work is made of: from the material chosen, else from the treatment. */
function materialOf(l: Layer): Material {
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
function presence(p: Paint): number {
  return p === "planned" ? 0.5 : p === "progress" ? 0.8 : 1;
}

/** The status, as an edge round the work: dashed red planned, dashed violet under way, a fine blue line done. */
function edge(p: Paint, w = 1.1): React.CSSProperties & { strokeDasharray?: string } {
  const loud = p === "planned" || p === "progress";
  return {
    stroke: INK[p],
    strokeWidth: loud ? w + 0.35 : w * 0.8,
    strokeDasharray: p === "planned" ? "3 2" : p === "progress" ? "4 1.6" : undefined,
    strokeLinejoin: "round",
  };
}

/** The one copy of the gradients every tooth on the page paints with. */
export function DentalDefs() {
  const stop = (offset: number, color: string, opacity = 1) => <stop offset={offset} style={{ stopColor: color, stopOpacity: opacity }} />;
  const metal = (id: string, light: string, mid: string, dark: string) => (
    <linearGradient id={`${DEFS}-${id}`} x1="0" y1="0" x2="1" y2="0.25">
      {stop(0, dark)}
      {stop(0.22, mid)}
      {stop(0.4, light)}
      {stop(0.55, mid)}
      {stop(0.78, dark)}
      {stop(1, mid)}
    </linearGradient>
  );
  return (
    <svg width="0" height="0" aria-hidden className="absolute" focusable="false">
      <defs>
        {/* Enamel across the crown: rounder at the middle, shaded at the sides. */}
        <linearGradient id={`${DEFS}-enamel`} x1="0" y1="0" x2="1" y2="0">
          {stop(0, "var(--color-tooth-shade)")}
          {stop(0.28, "var(--color-tooth-enamel)")}
          {stop(0.6, "var(--color-tooth-enamel)")}
          {stop(1, "var(--color-tooth-shade)")}
        </linearGradient>
        {/* Down the crown: warmer at the neck, where the dentin shows through; translucent at the edge. */}
        <linearGradient id={`${DEFS}-crown-v`} gradientUnits="userSpaceOnUse" x1="0" y1={Y0} x2="0" y2={YE}>
          {stop(0, "var(--color-tooth-cervical)", 0.75)}
          {stop(0.32, "var(--color-tooth-cervical)", 0)}
          {stop(0.8, "var(--color-tooth-incisal)", 0)}
          {stop(1, "var(--color-tooth-incisal)", 0.55)}
        </linearGradient>
        <linearGradient id={`${DEFS}-crown-v-back`} gradientUnits="userSpaceOnUse" x1="0" y1={Y0} x2="0" y2={YE}>
          {stop(0, "var(--color-tooth-cervical)", 0.75)}
          {stop(0.32, "var(--color-tooth-cervical)", 0)}
        </linearGradient>
        {/* The light on the enamel: a soft gloss, what makes a drawn tooth read as a tooth. */}
        <radialGradient id={`${DEFS}-gloss`} cx="0.5" cy="0.5" r="0.5">
          {stop(0, "white", 0.95)}
          {stop(0.55, "white", 0.45)}
          {stop(1, "white", 0)}
        </radialGradient>
        <linearGradient id={`${DEFS}-root`} x1="0" y1="0" x2="1" y2="0">
          {stop(0, "var(--color-tooth-root-shade)")}
          {stop(0.42, "var(--color-tooth-root)")}
          {stop(1, "var(--color-tooth-root-shade)")}
        </linearGradient>
        {/* The gingiva: deeper toward the mucosa, opaque at the margin, fading up the root. */}
        <linearGradient id={`${DEFS}-gum`} gradientUnits="userSpaceOnUse" x1="0" y1={GUM_TOP} x2="0" y2={PAP}>
          {stop(0, "var(--color-gum-deep)", 0)}
          {stop(0.32, "var(--color-gum-deep)", 0.38)}
          {stop(0.6, "var(--color-gum)", 0.82)}
          {stop(0.86, "var(--color-gum-light)", 0.96)}
          {stop(1, "var(--color-gum-light)", 1)}
        </linearGradient>
        <pattern id={`${DEFS}-stipple`} width="3.2" height="3.2" patternUnits="userSpaceOnUse">
          <circle cx="0.8" cy="0.9" r="0.35" style={{ fill: "var(--color-gum-deep)" }} opacity={0.22} />
          <circle cx="2.4" cy="2.3" r="0.3" style={{ fill: "white" }} opacity={0.35} />
        </pattern>
        <radialGradient id={`${DEFS}-top`} cx="0.42" cy="0.38" r="0.75">
          {stop(0, "var(--color-tooth-enamel)")}
          {stop(0.62, "var(--color-tooth-enamel)")}
          {stop(1, "var(--color-tooth-shade)")}
        </radialGradient>
        <radialGradient id={`${DEFS}-cusp`} cx="0.5" cy="0.5" r="0.5">
          {stop(0, "white", 0.85)}
          {stop(1, "white", 0)}
        </radialGradient>
        {/* Materials. */}
        <linearGradient id={`${DEFS}-ceramic`} x1="0" y1="0" x2="1" y2="0.3">
          {stop(0, "var(--color-mat-ceramic-shade)")}
          {stop(0.3, "var(--color-mat-ceramic)")}
          {stop(0.62, "var(--color-mat-ceramic)")}
          {stop(1, "var(--color-mat-ceramic-shade)")}
        </linearGradient>
        <linearGradient id={`${DEFS}-composite`} x1="0" y1="0" x2="1" y2="0">
          {stop(0, "var(--color-mat-composite-shade)")}
          {stop(0.5, "var(--color-mat-composite)")}
          {stop(1, "var(--color-mat-composite-shade)")}
        </linearGradient>
        {metal("metal", "var(--color-mat-metal-light)", "var(--color-mat-metal)", "var(--color-mat-metal-shade)")}
        {metal("gold", "var(--color-mat-gold-light)", "var(--color-mat-gold)", "var(--color-mat-gold-shade)")}
        {metal("amalgam", "var(--color-mat-metal)", "var(--color-mat-amalgam)", "var(--color-mat-amalgam-shade)")}
        {metal("titanium", "var(--color-mat-metal-light)", "var(--color-mat-titanium)", "var(--color-mat-titanium-shade)")}
        <linearGradient id={`${DEFS}-gic`} x1="0" y1="0" x2="1" y2="1">
          {stop(0, "var(--color-mat-gic)")}
          {stop(1, "var(--color-mat-gic-shade)")}
        </linearGradient>
        <linearGradient id={`${DEFS}-temp`} x1="0" y1="0" x2="1" y2="1">
          {stop(0, "var(--color-mat-temp)")}
          {stop(1, "var(--color-mat-temp-shade)")}
        </linearGradient>
        <linearGradient id={`${DEFS}-gutta`} x1="0" y1="0" x2="1" y2="0">
          {stop(0, "var(--color-mat-gutta-shade)")}
          {stop(0.5, "var(--color-mat-gutta)")}
          {stop(1, "var(--color-mat-gutta-shade)")}
        </linearGradient>
        <linearGradient id={`${DEFS}-mta`} x1="0" y1="0" x2="1" y2="1">
          {stop(0, "var(--color-mat-gic)")}
          {stop(1, "var(--color-mat-metal)")}
        </linearGradient>
        <linearGradient id={`${DEFS}-acrylic`} gradientUnits="userSpaceOnUse" x1="0" y1={Y0 - 16} x2="0" y2={Y0 + 8}>
          {stop(0, "var(--color-gum-deep)")}
          {stop(1, "var(--color-gum)")}
        </linearGradient>
        {/* Findings. */}
        <radialGradient id={`${DEFS}-decay`} cx="0.5" cy="0.5" r="0.5">
          {stop(0, "var(--color-dental-caries)")}
          {stop(0.55, "var(--color-dental-caries)", 0.92)}
          {stop(0.8, "var(--color-caries-halo)", 0.55)}
          {stop(1, "var(--color-caries-halo)", 0)}
        </radialGradient>
        <radialGradient id={`${DEFS}-abscess`} cx="0.5" cy="0.5" r="0.5">
          {stop(0, "var(--color-lesion)", 0.7)}
          {stop(0.6, "var(--color-lesion)", 0.35)}
          {stop(1, "var(--color-lesion)", 0)}
        </radialGradient>
        <radialGradient id={`${DEFS}-stain`} cx="0.5" cy="0.5" r="0.5">
          {stop(0, "var(--color-stain)", 0.75)}
          {stop(1, "var(--color-stain)", 0)}
        </radialGradient>
        <pattern id={`${DEFS}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" style={{ stroke: "var(--color-dental-finding)", strokeWidth: 1, opacity: 0.45 }} />
        </pattern>
      </defs>
    </svg>
  );
}

/** A material's fill. */
const fillOf = (m: Material) => (m === "mta" ? url("mta") : url(m));

/** Where a surface is on the side view, for a spot of caries or a small filling. */
function sideSpot(t: Tooth, s: Shape, sf: Surface): [number, number] {
  const mesialRight = t.side === "right";
  switch (sf) {
    case "O":
      return [C, YE - 4];
    case "B":
      return [C, 86];
    case "L":
      return [C + 3, 82];
    case "M":
      return [mesialRight ? C + s.mw - 4 : C - s.mw + 4, YB + 6];
    case "D":
      return [mesialRight ? C - s.mw + 4 : C + s.mw - 4, YB + 6];
  }
}

/** A filling's shape from the side, on the surface it was placed on. */
function SidePatch({ t, s, sf }: { t: Tooth; s: Shape; sf: Surface }) {
  const mesialRight = t.side === "right";
  const onRight = (sf === "M") === mesialRight;
  switch (sf) {
    case "O":
      return <path d={`M 0 ${YE - 7} Q ${C} ${YE - 10} ${CW} ${YE - 7} L ${CW} ${YE + 3} L 0 ${YE + 3} Z`} />;
    case "B":
      return <ellipse cx={C} cy={Y0 + 9} rx={s.nw * 0.85} ry={4.2} />;
    case "L":
      return <ellipse cx={C} cy={86} rx={s.mw * 0.36} ry={4.5} opacity={0.45} />;
    default:
      return onRight ? (
        <path d={`M ${C + s.mw - 7} ${YE + 2} L ${C + s.mw - 7} ${YB - 4} Q ${C + s.mw - 7} ${YB - 8} ${C + s.mw - 3} ${YB - 8} L ${CW} ${YB - 8} L ${CW} ${YE + 2} Z`} />
      ) : (
        <path d={`M ${C - s.mw + 7} ${YE + 2} L ${C - s.mw + 7} ${YB - 4} Q ${C - s.mw + 7} ${YB - 8} ${C - s.mw + 3} ${YB - 8} L 0 ${YB - 8} L 0 ${YE + 2} Z`} />
      );
  }
}

/** An irregular spot, the way decay or a stain spreads — not a circle. */
function blob(x: number, y: number, r: number, seed: number): string {
  const n = 7;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + seed;
    const k = 0.72 + 0.28 * Math.abs(Math.sin(seed * 3.1 + i * 1.7));
    pts.push(`${(x + Math.cos(a) * r * k).toFixed(2)} ${(y + Math.sin(a) * r * k * 0.85).toFixed(2)}`);
  }
  return `M ${pts[0]} ${pts.slice(1).map((p) => `L ${p}`).join(" ")} Z`;
}

function SideLayer({ l, t, s, crown, roots, clip }: { l: Layer; t: Tooth; s: Shape; crown: string; roots: Roots; clip: string }) {
  const mat = materialOf(l);
  const on = presence(l.paint);
  switch (l.look) {
    case "filling":
    case "inlay":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          {l.surfaces.map((sf) => (
            <g key={sf} style={{ fill: fillOf(mat), fillOpacity: on, ...edge(l.paint, l.look === "inlay" ? 1.3 : 1) }}>
              <SidePatch t={t} s={s} sf={sf} />
            </g>
          ))}
        </g>
      );
    case "caries":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          {l.surfaces.map((sf, i) => {
            const [x, y] = sideSpot(t, s, sf);
            return <path key={sf} d={blob(x, y, sf === "L" ? 3 : 4.2, i + 1.3)} style={{ fill: url("decay") }} opacity={sf === "L" ? 0.55 : 1} />;
          })}
        </g>
      );
    case "sealant":
      return (
        <path
          className="tooth-pop"
          clipPath={`url(#${clip})`}
          d={`M 0 ${YE - 3} Q ${C} ${YE - 6} ${CW} ${YE - 3} L ${CW} ${YE + 2} L 0 ${YE + 2} Z`}
          style={{ fill: "var(--color-mat-sealant)", fillOpacity: 0.75 * on, ...edge(l.paint, 0.8) }}
        />
      );
    case "core":
      return <path className="tooth-pop" d={chamberPath(s)} transform={`translate(${C} ${Y0}) scale(1.25 1.15) translate(${-C} ${-Y0})`} style={{ fill: fillOf(mat), fillOpacity: on, ...edge(l.paint) }} />;
    case "post": {
      const tip = Y0 - (Y0 - s.apex) * 0.55;
      return (
        <g className="tooth-pop">
          <path d={`M ${C - 2} ${Y0 + 8} L ${C - 1} ${tip} Q ${C} ${tip - 2} ${C + 1} ${tip} L ${C + 2} ${Y0 + 8} Z`} style={{ fill: url("metal"), fillOpacity: on, ...edge(l.paint, 0.9) }} />
          <path d={chamberPath(s)} transform={`translate(${C} ${Y0}) scale(1.2 1.1) translate(${-C} ${-Y0})`} style={{ fill: url("composite"), fillOpacity: on, ...edge(l.paint, 0.9) }} />
        </g>
      );
    }
    case "pulp":
      return <path className="tooth-pop" d={chamberPath(s)} style={{ fill: url("mta"), fillOpacity: on, ...edge(l.paint) }} />;
    case "rct": {
      const want = Number(l.detail.canals) || roots.canals.length;
      const canals = [...roots.canals];
      // More canals than the drawing has roots: a second canal in the first root.
      for (let i = canals.length; i < want; i++) {
        const [x1, y1, x2, y2] = roots.canals[0];
        canals.push([x1 + 1.8 * (i % 2 ? 1 : -1), y1, x2 + 2.4 * (i % 2 ? 1 : -1), y2 + 2]);
      }
      const shown = canals.slice(0, Math.max(want, 1));
      // Planned: where the canals will be, dashed. Done: gutta-percha down each canal, the chamber sealed.
      if (l.paint === "planned" || l.paint === "progress") {
        return (
          <g className="tooth-pop" style={{ fill: "none", ...edge(l.paint, 0.9) }}>
            <path d={chamberPath(s)} style={{ fill: SOFT[l.paint], fillOpacity: 0.7 }} />
            {shown.map((c, i) => (
              <path key={i} d={canalPath(c)} style={{ fill: l.paint === "progress" ? url("gutta") : "none", fillOpacity: 0.55 }} />
            ))}
          </g>
        );
      }
      return (
        <g className="tooth-pop">
          {shown.map((c, i) => (
            <path key={i} d={canalPath(c)} style={{ fill: url("gutta"), stroke: "var(--color-mat-gutta-shade)", strokeWidth: 0.4 }} />
          ))}
          <path d={chamberPath(s)} style={{ fill: url("composite"), ...edge(l.paint, 0.9) }} />
        </g>
      );
    }
    case "apico":
      return (
        <g className="tooth-pop">
          {roots.apices.map(([x, y], i) => (
            <g key={i}>
              <rect x={x - 2.4} y={y + 4} width={4.8} height={3} rx={1} style={{ fill: url("mta"), fillOpacity: presence(l.paint) }} />
              <line x1={x - 4.5} y1={y + 4} x2={x + 4.5} y2={y + 4} style={{ ...edge(l.paint, 1.4) }} strokeLinecap="round" />
            </g>
          ))}
        </g>
      );
    case "crown":
    case "denture": {
      const metalCollar = l.detail.material === "pfm";
      // A crown sits over the prepared tooth, a touch fuller than it.
      const over = `translate(${C} ${YE}) scale(1.035 1.02) translate(${-C} ${-YE})`;
      return (
        <g className="tooth-pop">
          {l.look === "denture" && (
            // The pink acrylic base, festooned like gum and the column wide, so a full arch reads as one piece.
            <>
              <path d={festoon(Y0 - 16)} style={{ fill: url("acrylic"), fillOpacity: on }} />
              <path d={gumMargin()} style={{ fill: "none", ...edge(l.paint, 0.9) }} />
            </>
          )}
          <path d={crown} transform={over} style={{ fill: url(l.look === "denture" ? "composite" : mat), fillOpacity: on, ...edge(l.paint, 1.3) }} />
          {metalCollar && (
            <path
              d={`M ${C - s.nw - 0.5} ${Y0 + 0.5} Q ${C} ${Y0 - 4} ${C + s.nw + 0.5} ${Y0 + 0.5} L ${C + s.nw + 1.6} ${Y0 + 4.2} Q ${C} ${Y0} ${C - s.nw - 1.6} ${Y0 + 4.2} Z`}
              style={{ fill: url("metal"), fillOpacity: on }}
            />
          )}
          {(mat === "ceramic" || mat === "temp") && on === 1 && (
            <ellipse cx={C - s.mw * 0.42} cy={YB + 6} rx={2.6} ry={8} style={{ fill: url("gloss") }} transform={`rotate(-6 ${C - s.mw * 0.42} ${YB + 6})`} />
          )}
        </g>
      );
    }
    case "veneer":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          {/* The shell covers the front, its margin just short of the neck. */}
          <path d={crown} transform={`translate(${C} ${YE}) scale(1.02 0.9) translate(${-C} ${-YE})`} style={{ fill: url(mat === "composite" ? "composite" : "ceramic"), fillOpacity: 0.95 * on, ...edge(l.paint, 1.1) }} />
          {on === 1 && <ellipse cx={C - s.mw * 0.4} cy={YB + 8} rx={2.2} ry={7} style={{ fill: url("gloss") }} />}
        </g>
      );
    case "implant": {
      const top = Y0 - 1;
      const bot = s.apex + 6;
      const threads: number[] = [];
      for (let y = top - 5; y > bot + 3; y -= 4.2) threads.push(y);
      const w = (y: number) => 5.4 - ((top - y) / (top - bot)) * 1.5;
      return (
        <g className="tooth-pop" opacity={on}>
          <path d={`M ${C - 5.4} ${top} L ${C + 5.4} ${top} L ${C + 3.9} ${bot + 4} Q ${C} ${bot - 1.5} ${C - 3.9} ${bot + 4} Z`} style={{ fill: url("titanium"), ...edge(l.paint, 1) }} />
          {threads.map((y) => (
            <path key={y} d={`M ${C - w(y) - 1.1} ${y + 1} L ${C + w(y) + 1.1} ${y - 1.4}`} style={{ stroke: "var(--color-mat-titanium-shade)", strokeWidth: 1.15 }} strokeLinecap="round" />
          ))}
          {threads.map((y) => (
            <path key={`h${y}`} d={`M ${C - w(y) + 0.5} ${y - 0.3} L ${C + w(y) - 0.5} ${y - 2.4}`} style={{ stroke: "var(--color-mat-metal-light)", strokeWidth: 0.55 }} opacity={0.8} />
          ))}
          {/* The abutment (or a healing cap), through the gum. */}
          <path d={`M ${C - 4} ${top} L ${C - 3.2} ${Y0 + 7} L ${C + 3.2} ${Y0 + 7} L ${C + 4} ${top} Z`} style={{ fill: url("titanium"), ...edge(l.paint, 0.8) }} />
        </g>
      );
    }
    case "extraction":
      // Planned: the tooth wears a cross until it is out. (Once out, it is drawn gone.)
      return (
        <g className="tooth-pop" strokeLinecap="round">
          <g style={{ stroke: "white", strokeWidth: 4.4 }} opacity={0.8}>
            <line x1={C - s.mw} y1={s.apex + 4} x2={C + s.mw} y2={YE - 1} />
            <line x1={C + s.mw} y1={s.apex + 4} x2={C - s.mw} y2={YE - 1} />
          </g>
          <g style={{ stroke: INK[l.paint], strokeWidth: 2.4 }}>
            <line x1={C - s.mw} y1={s.apex + 4} x2={C + s.mw} y2={YE - 1} />
            <line x1={C + s.mw} y1={s.apex + 4} x2={C - s.mw} y2={YE - 1} />
          </g>
        </g>
      );
    case "root":
      return null; // drawn with the tooth: the crown broken away (see ToothSide)
    case "fracture":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`} strokeLinejoin="round" strokeLinecap="round" style={{ fill: "none" }}>
          <polyline points={`${C - s.mw + 2},${YB} ${C - 3},${YB + 9} ${C + 1},${YB + 6} ${C + 4},${YB + 13} ${C + s.mw - 1},${YB + 19}`} style={{ stroke: "white", strokeWidth: 2.4 }} opacity={0.85} />
          <polyline points={`${C - s.mw + 2},${YB} ${C - 3},${YB + 9} ${C + 1},${YB + 6} ${C + 4},${YB + 13} ${C + s.mw - 1},${YB + 19}`} style={{ stroke: "var(--color-crack)", strokeWidth: 1.1 }} />
        </g>
      );
    case "wear":
      // Flattened at the edge, the dentin showing through.
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          <rect x={0} y={YE - 6} width={CW} height={9} style={{ fill: "var(--color-tooth-root)" }} />
          <ellipse cx={C} cy={YE - 1} rx={s.mw * 0.55} ry={2.4} style={{ fill: "var(--color-tooth-root-shade)" }} />
          <line x1={0} y1={YE - 6} x2={CW} y2={YE - 6} style={{ stroke: "var(--color-tooth-line)", strokeWidth: 0.8 }} />
        </g>
      );
    case "stain":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          <path d={blob(C - 5, 80, 6, 0.4)} style={{ fill: url("stain") }} />
          <path d={blob(C + 5, 88, 5, 1.9)} style={{ fill: url("stain") }} />
          <path d={blob(C - 1, 94, 4, 3.3)} style={{ fill: url("stain") }} opacity={0.8} />
        </g>
      );
    case "lesion":
      return (
        <g className="tooth-pop">
          {roots.apices.map(([x, y], i) => (
            <ellipse key={i} cx={x} cy={y + 1} rx={7.5} ry={6.5} style={{ fill: url("abscess") }} />
          ))}
        </g>
      );
    case "furcation":
      return roots.furcation ? (
        <path
          className="tooth-pop"
          d={`M ${roots.furcation[0]} ${roots.furcation[1] - 9} Q ${roots.furcation[0] - 6} ${roots.furcation[1] + 1} ${roots.furcation[0]} ${roots.furcation[1] + 1} Q ${roots.furcation[0] + 6} ${roots.furcation[1] + 1} ${roots.furcation[0]} ${roots.furcation[1] - 9} Z`}
          style={{ fill: url("abscess") }}
        />
      ) : null;
    case "recession": {
      // The gum has drawn back: the root is bare between the neck and the new margin.
      const low = Y0 - 9;
      return (
        <g className="tooth-pop">
          <path d={`M ${C - s.nw - 0.5} ${Y0 + 1} L ${C - s.nw + 0.5} ${low} Q ${C} ${low - 3} ${C + s.nw - 0.5} ${low} L ${C + s.nw + 0.5} ${Y0 + 1} Q ${C} ${Y0 - 4} ${C - s.nw - 0.5} ${Y0 + 1} Z`} style={{ fill: url("root") }} />
          <path d={`M ${C - s.nw - 3} ${low + 1} Q ${C} ${low - 4} ${C + s.nw + 3} ${low + 1}`} style={{ fill: "none", stroke: "var(--color-gum-line)", strokeWidth: 1.6 }} strokeLinecap="round" />
        </g>
      );
    }
    case "gum":
      // Gum work (a graft, a recontouring): the new margin, in the status' edge.
      return (
        <g className="tooth-pop">
          {l.paint !== "planned" && <path d={`M ${C - s.nw - 4} ${Y0 - 3} Q ${C} ${Y0 - 9} ${C + s.nw + 4} ${Y0 - 3} L ${C + s.nw + 4} ${Y0 + 3} Q ${C} ${Y0 - 2} ${C - s.nw - 4} ${Y0 + 3} Z`} style={{ fill: "var(--color-gum-deep)", fillOpacity: 0.45 }} />}
          <path d={`M ${C - s.nw - 4} ${Y0 - 3} Q ${C} ${Y0 - 9} ${C + s.nw + 4} ${Y0 - 3}`} style={{ fill: "none", ...edge(l.paint, 1.5) }} strokeLinecap="round" />
        </g>
      );
    case "rotation":
      return (
        <g className="tooth-pop" style={{ fill: "none", stroke: INK.finding, strokeWidth: 1.6 }} strokeLinecap="round">
          <path d={`M ${C - 6} 85 A 6.5 6.5 0 1 1 ${C + 4.8} 90`} />
          <path d={`M ${C + 1.8} 90.5 L ${C + 5} 90.2 L ${C + 5.6} 87`} />
        </g>
      );
    case "graft":
      // Bone graft granules, packed round the root.
      return (
        <g className="tooth-pop" opacity={on}>
          {[
            [C - s.nw - 3, Y0 - 12, 1.9],
            [C + s.nw + 3, Y0 - 20, 1.6],
            [C - s.nw - 1.5, Y0 - 28, 1.7],
            [C + s.nw + 1, Y0 - 9, 2],
            [C - s.nw - 4, Y0 - 20, 1.3],
            [C + s.nw + 3.5, Y0 - 30, 1.4],
            [C - 4, s.apex - 2, 1.6],
            [C + 4, s.apex, 1.5],
          ].map(([x, y, r], i) => (
            <path key={i} d={blob(x, y, r, i * 0.9)} style={{ fill: "var(--color-mat-gic)", stroke: INK[l.paint], strokeWidth: 0.5 }} />
          ))}
        </g>
      );
    case "bracket":
      return (
        <g className="tooth-pop" opacity={on}>
          <line x1={0} y1={85} x2={CW} y2={85} style={{ stroke: "var(--color-mat-metal-shade)", strokeWidth: 0.9 }} />
          <rect x={C - 4.5} y={81} width={9} height={8} rx={1.6} style={{ fill: url("metal"), ...edge(l.paint, 0.9) }} />
          <line x1={C - 4.5} y1={85} x2={C + 4.5} y2={85} style={{ stroke: "var(--color-mat-metal-shade)", strokeWidth: 1.2 }} />
        </g>
      );
    case "band":
      return <rect className="tooth-pop" x={C - s.mw - 0.5} y={77} width={s.mw * 2 + 1} height={10} rx={2} style={{ fill: url("metal"), fillOpacity: on, ...edge(l.paint, 1) }} />;
    case "splint":
      return (
        <g className="tooth-pop" opacity={on}>
          <line x1={0} y1={93} x2={CW} y2={93} style={{ stroke: "var(--color-mat-metal-shade)", strokeWidth: 1.2 }} />
          <ellipse cx={C} cy={93} rx={4} ry={2.4} style={{ fill: url("composite"), ...edge(l.paint, 0.8) }} />
        </g>
      );
    default:
      return null;
  }
}

/** Grade and other words, kept out of the flipped group so they never read backwards. */
function SideText({ t, st, visible }: { t: Tooth; st: ToothState; visible: (p: Paint) => boolean }) {
  const mob = st.layers.find((l) => l.look === "mobility" && visible(l.paint));
  if (!mob) return null;
  const s = shapeOf(t);
  const y = t.arch === "upper" ? YE - 14 : SIDE_H - (YE - 14);
  const grade = mob.detail.grade ? ["", "I", "II", "III"][Number(mob.detail.grade)] ?? "" : "";
  return (
    <g className="tooth-pop" style={{ stroke: INK.finding, fill: INK.finding }}>
      <line x1={C - s.mw + 2} y1={y} x2={C + s.mw - 2} y2={y} strokeWidth={1.4} />
      <path d={`M ${C - s.mw + 1} ${y} l 3 -2.4 v 4.8 Z M ${C + s.mw - 1} ${y} l -3 -2.4 v 4.8 Z`} strokeWidth={0.6} />
      {grade && (
        <text x={C} y={y - 3} textAnchor="middle" fontSize={7.5} fontWeight={700} style={{ stroke: "none" }}>
          {grade}
        </text>
      )}
    </g>
  );
}

/**
 * The tooth from the side. `uid` keeps clip-path ids unique when the same tooth
 * is drawn twice on one page — in the chart and in the panel beside it.
 */
export function ToothSide({ t, st, uid, visible = () => true }: { t: Tooth; st: ToothState; uid: string; visible?: (p: Paint) => boolean }) {
  const s = shapeOf(t);
  const crown = crownPath(s);
  const roots = rootGeom(s);
  const clip = `${uid}-c${t.fdi}`;
  const rootClip = `${uid}-r${t.fdi}`;
  const layers = st.layers.filter((l) => visible(l.paint) && l.look !== "mobility");
  const rootOnly = layers.some((l) => l.look === "root");
  // A root tip taken off (an apicectomy done): the roots end short of where they did.
  const cut = layers.some((l) => l.look === "apico" && l.paint !== "planned" && l.paint !== "progress");
  const buried = st.buried && visible(st.buried.paint) ? st.buried : null;
  const flip = t.arch === "lower" ? `matrix(1 0 0 -1 0 ${SIDE_H})` : undefined;
  const move = buried ? `translate(0 ${buried.look === "impacted" ? -19 : -24}) rotate(${buried.look === "impacted" ? (t.side === "right" ? 16 : -16) : 0} ${C} ${Y0 + 12})` : undefined;
  const front = t.kind === "incisor" || t.kind === "canine";
  // What is left of a broken-down tooth: the crown gone below a jagged edge, dark where it broke.
  const stump = `M ${C - s.nw - 0.5} ${Y0} L ${C - s.nw - 1} ${Y0 + 6} L ${C - s.nw / 2} ${Y0 + 9} L ${C - 2} ${Y0 + 5} L ${C + 2} ${Y0 + 10} L ${C + s.nw / 2} ${Y0 + 6} L ${C + s.nw + 1} ${Y0 + 8} L ${C + s.nw + 0.5} ${Y0} Q ${C} ${Y0 - 5} ${C - s.nw - 0.5} ${Y0} Z`;

  const natural = (
    <g transform={move} opacity={buried ? 0.9 : 1}>
      <g clipPath={cut ? `url(#${rootClip})` : undefined}>
        {roots.back && <path d={roots.back} fill={url("root")} style={{ stroke: LINE, strokeWidth: 0.5 }} opacity={0.5} />}
        <path d={roots.body} fill={url("root")} style={{ stroke: LINE, strokeWidth: 0.6 }} />
        <g style={{ stroke: "var(--color-tooth-pulp)", strokeWidth: 1.2 }} opacity={0.5} strokeLinecap="round">
          {roots.canals.map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
      </g>
      {rootOnly ? (
        <g>
          <path d={stump} fill={url("root")} style={{ stroke: LINE, strokeWidth: 0.6 }} />
          <polyline
            points={`${C - s.nw - 1},${Y0 + 6} ${C - s.nw / 2},${Y0 + 9} ${C - 2},${Y0 + 5} ${C + 2},${Y0 + 10} ${C + s.nw / 2},${Y0 + 6} ${C + s.nw + 1},${Y0 + 8}`}
            style={{ fill: "none", stroke: "var(--color-dental-caries)", strokeWidth: 1.6 }}
            strokeLinejoin="round"
          />
        </g>
      ) : (
        <>
          <path d={crown} fill={url("enamel")} style={{ stroke: LINE, strokeWidth: 0.65 }} />
          <path d={crown} fill={url(front ? "crown-v" : "crown-v-back")} />
          <path d={chamberPath(s)} style={{ fill: "var(--color-tooth-pulp)" }} opacity={0.22} />
          {/* The gloss on the enamel, and a thinner one down the far side. */}
          <ellipse cx={C - s.mw * 0.45} cy={YB + 7} rx={2.8} ry={10} style={{ fill: url("gloss") }} transform={`rotate(-5 ${C - s.mw * 0.45} ${YB + 7})`} />
          <ellipse cx={C + s.mw * 0.55} cy={YB + 4} rx={1.2} ry={6} style={{ fill: url("gloss") }} opacity={0.5} />
          {front && t.arch === "upper" && t.kind === "incisor" && (
            // The faint lobes of an incisor's edge.
            <path d={`M ${C - s.mw * 0.35} ${YE - 1} Q ${C - s.mw * 0.35} ${YE - 9} ${C - s.mw * 0.3} ${YE - 14} M ${C + s.mw * 0.35} ${YE - 1} Q ${C + s.mw * 0.35} ${YE - 9} ${C + s.mw * 0.3} ${YE - 14}`} style={{ fill: "none", stroke: "var(--color-tooth-shade)", strokeWidth: 0.8 }} opacity={0.7} />
          )}
        </>
      )}
    </g>
  );

  return (
    <>
      <g transform={flip}>
        <defs>
          <clipPath id={clip}>
            <path d={crown} />
          </clipPath>
          <clipPath id={rootClip}>
            <rect x={0} y={Math.min(...roots.apices.map(([, y]) => y)) + 5} width={CW} height={SIDE_H} />
          </clipPath>
        </defs>
        {/*
          The gum is drawn over the tooth, not under it: it covers the neck and
          fades out up the root the way soft tissue does, and the papilla sits in
          front of the contact between two crowns.
        */}
        {st.gone ? (
          <g style={{ fill: "none", stroke: "var(--color-ink-300)", strokeWidth: 0.9 }} strokeDasharray="2.5 2" opacity={0.8}>
            <path d={roots.body} />
            <path d={crown} />
          </g>
        ) : (
          natural
        )}
        <path d={gumPath()} fill={url("gum")} opacity={buried ? 1 : 0.97} />
        <path d={gumPath()} fill={url("stipple")} opacity={0.35} />
        {buried && <path d={gumPath()} style={{ fill: "var(--color-gum)" }} opacity={0.4} />}
        {/* The free margin: a lighter rim, and the fine dark line where gum meets tooth. */}
        <path d={gumMargin()} style={{ fill: "none", stroke: "var(--color-gum-light)", strokeWidth: 2.2 }} opacity={0.9} transform="translate(0 -1.2)" />
        <path d={gumMargin()} style={{ fill: "none", stroke: "var(--color-gum-line)", strokeWidth: 0.8 }} opacity={0.8} />
        {layers.map((l) => (
          <SideLayer key={l.markId + l.surfaces.join("")} l={l} t={t} s={s} crown={crown} roots={roots} clip={clip} />
        ))}
      </g>
      <SideText t={t} st={st} visible={visible} />
    </>
  );
}

/* ── From above ──────────────────────────────────────────────────────────── */

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return `M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
}

export function topOutline(t: Tooth): string {
  const c = OCC / 2;
  if (t.kind === "molar") {
    const w = t.primary ? 32 : t.position === 8 ? 34 : t.position === 7 ? 36 : 38;
    const h = t.arch === "upper" ? 35 : 33;
    return roundRect(c - w / 2, c - h / 2, w, h, 11);
  }
  if (t.kind === "premolar") return ellipse(c, c, 14.5, 17);
  if (t.kind === "canine") return ellipse(c, c, 14.5, 15.5);
  if (t.arch === "upper") return t.position === 1 ? ellipse(c, c, 17.5, 11.5) : ellipse(c, c, 15, 10.5);
  return ellipse(c, c, 12.5, 10);
}

const REGIONS = {
  top: "0,0 44,0 22,22",
  right: "44,0 44,44 22,22",
  bottom: "44,44 0,44 22,22",
  left: "0,44 0,0 22,22",
} as const;
type Region = keyof typeof REGIONS;
const CENTROID: Record<Region | "center", [number, number]> = {
  top: [22, 9],
  bottom: [22, 35],
  left: [9, 22],
  right: [35, 22],
  center: [22, 22],
};
const INNER = "translate(22 22) scale(0.42) translate(-22 -22)";

function regionOf(t: Tooth, sf: Surface): Region | "center" {
  if (sf === "O") return "center";
  return (Object.keys(REGIONS) as Region[]).find((r) => surfaceAt(t, r) === sf)!;
}

function SurfaceFill({ t, outline, sf, style, dash }: { t: Tooth; outline: string; sf: Surface; style: React.CSSProperties; dash?: string }) {
  const r = regionOf(t, sf);
  if (r === "center") return <path d={outline} transform={INNER} style={style} strokeDasharray={dash} />;
  return <polygon points={REGIONS[r]} style={style} strokeDasharray={dash} />;
}

/** The chewing surface as it looks: cusps catching the light, the grooves between them. */
function Anatomy({ t }: { t: Tooth }) {
  const groove = { fill: "none", stroke: "var(--color-tooth-groove)", strokeWidth: 0.9, strokeLinecap: "round" as const };
  const cusp = (cx: number, cy: number, r: number) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} style={{ fill: url("cusp") }} />;
  if (t.kind === "molar") {
    return (
      <g>
        {[cusp(13.5, 13.5, 6.5), cusp(30.5, 13.5, 6.5), cusp(13.5, 30.5, 6.5), cusp(30.5, 30.5, 6.5)]}
        <path d="M 9 22 Q 15 20.5 18.5 22 Q 22 23.5 25.5 22 Q 29 20.5 35 22" style={groove} />
        <path d="M 22 9 Q 20.5 15 22 18.5 Q 23.5 22 22 25.5 Q 20.5 29 22 35" style={groove} opacity={0.85} />
        <circle cx={22} cy={22} r={1.3} style={{ fill: "var(--color-tooth-groove)" }} opacity={0.75} />
      </g>
    );
  }
  if (t.kind === "premolar") {
    return (
      <g>
        {[cusp(22, 14, 6.5), cusp(22, 30, 5.5)]}
        <path d="M 13 22 Q 17 20.6 22 22 Q 27 23.4 31 22" style={groove} />
        <circle cx={14.5} cy={22} r={1} style={{ fill: "var(--color-tooth-groove)" }} opacity={0.7} />
        <circle cx={29.5} cy={22} r={1} style={{ fill: "var(--color-tooth-groove)" }} opacity={0.7} />
      </g>
    );
  }
  if (t.kind === "canine") {
    return (
      <g>
        {cusp(22, 20, 6)}
        <path d="M 22 13 L 22 27 M 13 21 L 31 21" style={{ ...groove, stroke: "var(--color-tooth-shade)", strokeWidth: 0.8 }} opacity={0.8} />
      </g>
    );
  }
  // An incisor from above: its edge, and the hollow behind it.
  return (
    <g>
      <path d="M 9 20 Q 22 16.5 35 20" style={{ ...groove, stroke: "var(--color-tooth-shade)", strokeWidth: 1.4 }} />
      <ellipse cx={22} cy={25} rx={7} ry={3.2} style={{ fill: "var(--color-tooth-shade)" }} opacity={0.45} />
    </g>
  );
}

function TopLayer({ l, t, outline, clip }: { l: Layer; t: Tooth; outline: string; clip: string }) {
  const mat = materialOf(l);
  const on = presence(l.paint);
  const status = edge(l.paint);
  switch (l.look) {
    case "filling":
    case "inlay":
    case "sealant": {
      const style = l.look === "sealant" ? { fill: "var(--color-mat-sealant)", fillOpacity: 0.75 * on, ...edge(l.paint, 0.8) } : { fill: fillOf(mat), fillOpacity: on, ...edge(l.paint, l.look === "inlay" ? 1.3 : 1) };
      const surfaces = l.look === "sealant" ? (["O"] as Surface[]) : l.surfaces;
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          {surfaces.map((sf) => (
            <SurfaceFill key={sf} t={t} outline={outline} sf={sf} style={style} dash={style.strokeDasharray} />
          ))}
        </g>
      );
    }
    case "caries":
      return (
        <g className="tooth-pop">
          {l.surfaces.map((sf, i) => {
            const [x, y] = CENTROID[regionOf(t, sf)];
            return <path key={sf} d={blob(x, y, 4.6, i * 1.7 + 0.6)} style={{ fill: url("decay") }} />;
          })}
        </g>
      );
    case "crown":
    case "denture":
      return (
        <g className="tooth-pop">
          <path d={outline} style={{ fill: url(l.look === "denture" ? "composite" : mat), fillOpacity: on, ...edge(l.paint, 1.4) }} />
          <path d={outline} transform={INNER} style={{ fill: "none", stroke: "var(--color-tooth-groove)", strokeWidth: 1.6 }} opacity={0.35 * on} />
          {mat !== "metal" && mat !== "gold" && on === 1 && <ellipse cx={17} cy={16} rx={7} ry={4.5} style={{ fill: url("gloss") }} />}
        </g>
      );
    case "veneer":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          <SurfaceFill t={t} outline={outline} sf="B" style={{ fill: url(mat === "composite" ? "composite" : "ceramic"), fillOpacity: on, ...edge(l.paint, 1.1) }} dash={status.strokeDasharray} />
        </g>
      );
    case "rct":
    case "post":
    case "core":
      // The access cavity, sealed: a round white filling in the middle of the tooth.
      return (
        <g className="tooth-pop">
          <circle cx={22} cy={22} r={l.look === "core" ? 6 : 4.6} style={{ fill: url("composite"), fillOpacity: on, ...edge(l.paint, 1) }} />
          {l.look === "rct" && l.paint !== "planned" && <circle cx={22} cy={22} r={1.5} style={{ fill: url("gutta") }} />}
          {l.look === "post" && <circle cx={22} cy={22} r={1.7} style={{ fill: url("metal") }} />}
        </g>
      );
    case "pulp":
      return <circle className="tooth-pop" cx={22} cy={22} r={3.6} style={{ fill: url("mta"), fillOpacity: on, ...edge(l.paint, 1) }} />;
    case "implant": {
      const hex = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return `${22 + 3.2 * Math.cos(a)},${22 + 3.2 * Math.sin(a)}`;
      }).join(" ");
      return (
        <g className="tooth-pop" opacity={on}>
          <circle cx={22} cy={22} r={8} style={{ fill: url("titanium"), ...edge(l.paint, 1.2) }} />
          <circle cx={22} cy={22} r={5.6} style={{ fill: "none", stroke: "var(--color-mat-titanium-shade)", strokeWidth: 0.8 }} />
          <polygon points={hex} style={{ fill: "var(--color-mat-titanium-shade)", stroke: "var(--color-mat-metal-light)", strokeWidth: 0.6 }} />
        </g>
      );
    }
    case "extraction":
      return (
        <g className="tooth-pop" strokeLinecap="round">
          <g style={{ stroke: "white", strokeWidth: 4.4 }} opacity={0.8}>
            <line x1={8} y1={8} x2={36} y2={36} />
            <line x1={36} y1={8} x2={8} y2={36} />
          </g>
          <g style={{ stroke: INK[l.paint], strokeWidth: 2.4 }}>
            <line x1={8} y1={8} x2={36} y2={36} />
            <line x1={36} y1={8} x2={8} y2={36} />
          </g>
        </g>
      );
    case "bracket": {
      const y = surfaceAt(t, "top") === "B" ? 6 : 31;
      return (
        <g className="tooth-pop" opacity={on}>
          <rect x={17} y={y} width={10} height={7} rx={1.5} style={{ fill: url("metal"), ...edge(l.paint, 0.8) }} />
          <line x1={17} y1={y + 3.5} x2={27} y2={y + 3.5} style={{ stroke: "var(--color-mat-metal-shade)", strokeWidth: 1 }} />
        </g>
      );
    }
    case "band":
      return <path className="tooth-pop" d={outline} style={{ fill: "none", stroke: url("metal"), strokeWidth: 3.2, strokeOpacity: on }} />;
    case "fracture":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`} strokeLinejoin="round" strokeLinecap="round" style={{ fill: "none" }}>
          <polyline points="9,12 18,21 23,17 27,25 35,32" style={{ stroke: "white", strokeWidth: 2.2 }} opacity={0.85} />
          <polyline points="9,12 18,21 23,17 27,25 35,32" style={{ stroke: "var(--color-crack)", strokeWidth: 1 }} />
        </g>
      );
    case "wear":
      return <path className="tooth-pop" d={outline} transform={INNER} style={{ fill: "var(--color-tooth-root)", stroke: "var(--color-tooth-root-shade)", strokeWidth: 1.6 }} />;
    case "stain":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          <path d={blob(16, 17, 6, 0.7)} style={{ fill: url("stain") }} />
          <path d={blob(28, 27, 5.5, 2.2)} style={{ fill: url("stain") }} />
        </g>
      );
    default:
      return null;
  }
}

/**
 * The tooth from above, its five surfaces each a target. `picked` outlines
 * the surfaces chosen in the panel; `onSurface` makes them tappable.
 */
export function ToothTop({
  t,
  st,
  uid,
  visible = () => true,
  picked,
  onSurface,
}: {
  t: Tooth;
  st: ToothState;
  uid: string;
  visible?: (p: Paint) => boolean;
  picked?: Surface[];
  onSurface?: (s: Surface, e: React.MouseEvent) => void;
}) {
  const outline = topOutline(t);
  const clip = `${uid}-t${t.fdi}`;
  const layers = st.layers.filter((l) => visible(l.paint));
  const buried = st.buried && visible(st.buried.paint);
  const gone = st.gone;
  const covered = layers.some((l) => l.look === "crown" || l.look === "denture");

  return (
    <g>
      <defs>
        <clipPath id={clip}>
          <path d={outline} />
        </clipPath>
      </defs>
      {gone || buried ? (
        <path d={outline} style={{ fill: buried ? `url(#${DEFS}-hatch)` : "none", stroke: "var(--color-ink-300)", strokeWidth: 1 }} strokeDasharray="2.5 2" />
      ) : (
        <>
          <path d={outline} fill={url("top")} style={{ stroke: LINE, strokeWidth: 0.7 }} />
          {!covered && (
            <g clipPath={`url(#${clip})`}>
              <Anatomy t={t} />
            </g>
          )}
          {/* The five surfaces, faintly: where a tap lands. */}
          <g clipPath={`url(#${clip})`} style={{ stroke: LINE, strokeWidth: 0.5 }} opacity={0.3}>
            <line x1={0} y1={0} x2={44} y2={44} />
            <line x1={44} y1={0} x2={0} y2={44} />
          </g>
          <path d={outline} transform={INNER} style={{ fill: "none", stroke: LINE, strokeWidth: 0.5 / 0.42 }} opacity={0.35} />
        </>
      )}
      {layers.map((l) => (
        <TopLayer key={l.markId + l.surfaces.join("")} l={l} t={t} outline={outline} clip={clip} />
      ))}
      {picked && picked.length > 0 && (
        <g clipPath={`url(#${clip})`} style={{ fill: "var(--color-night)", fillOpacity: 0.16, stroke: "var(--color-night)", strokeWidth: 1.4 }}>
          {picked.map((sf) => (
            <SurfaceFill key={sf} t={t} outline={outline} sf={sf} style={{}} />
          ))}
        </g>
      )}
      {onSurface && (
        <g style={{ fill: "transparent", cursor: "pointer" }}>
          <g clipPath={`url(#${clip})`}>
            {(Object.keys(REGIONS) as Region[]).map((r) => (
              <polygon key={r} points={REGIONS[r]} onClick={(e) => onSurface(surfaceAt(t, r), e)} data-surface={surfaceAt(t, r)} />
            ))}
          </g>
          <path d={outline} transform={INNER} onClick={(e) => onSurface("O", e)} data-surface="O" />
        </g>
      )}
    </g>
  );
}

/** A tooth that shows what one look does, for the picker's chips and the entry rows. */
export function LookGlyph({ look, paint, t, uid, size = 30 }: { look: Look; paint: Paint; t: Tooth; uid: string; size?: number }) {
  const surfaces: Surface[] = look === "caries" || look === "filling" || look === "inlay" ? ["O", t.side === "right" ? "M" : "D"] : [];
  const layer: Layer = { markId: "g", look, paint, surfaces, detail: {} };
  const st: ToothState =
    look === "missing"
      ? { gone: true, buried: null, layers: [], badges: [] }
      : look === "impacted" || look === "unerupted"
        ? { gone: false, buried: { look, paint }, layers: [], badges: [] }
        : look === "implant" || look === "denture"
          ? { gone: true, buried: null, layers: [layer], badges: [] }
          : { gone: false, buried: null, layers: [layer], badges: [] };
  return (
    <svg viewBox={`2 0 40 ${SIDE_H}`} width={size * 0.4} height={size} aria-hidden className="shrink-0 overflow-visible">
      <ToothSide t={t} st={st} uid={uid} />
    </svg>
  );
}

/**
 * A crown the size of a letter, drawn the way each status is drawn on the
 * chart — dashed red for planned, solid blue for done, slate for existing,
 * a brown spot for a finding — so the legend is a sample of the picture and
 * not a coloured dot to be matched against it.
 */
export function PaintSwatch({ paint, size = 16 }: { paint: Paint; size?: number }) {
  const crown = "M3 6.5 C3 3.2 5 2 8 2 C11 2 13 3.2 13 6.5 L12.4 12.2 C12 15 10.4 15.6 8 13.6 C5.6 15.6 4 15 3.6 12.2 Z";
  const ink = INK[paint];
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden className="shrink-0">
      {paint === "finding" ? (
        <>
          <path d={crown} style={{ fill: "var(--color-tooth-enamel)", stroke: "var(--color-tooth-line)", strokeWidth: 1.1 }} />
          <circle cx={9.4} cy={6.4} r={2.1} style={{ fill: "var(--color-dental-caries)" }} />
        </>
      ) : (
        <path
          d={crown}
          style={{ fill: paint === "planned" || paint === "progress" ? SOFT[paint] : ink, stroke: ink, strokeWidth: paint === "planned" || paint === "progress" ? 1.3 : 1 }}
          strokeDasharray={paint === "planned" ? "2 1.4" : undefined}
        />
      )}
    </svg>
  );
}

export { crownPath, rootGeom };
