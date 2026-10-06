"use client";

/*
  The drawing of one tooth, twice: from the side (crown, roots and gum) and from
  above (the five surfaces). Everything recorded on the tooth is a layer drawn
  onto these, so a filling fills the surface it was placed on, a root canal runs
  down the roots, an implant replaces them and an extraction leaves a ghost.

  Geometry is in tooth-local units: a 44-wide column, 104 tall from the root
  apex (y≈5) to the biting edge (y=100), drawn as an upper tooth. A lower tooth
  is the same drawing flipped, so its roots point down and its crown up, the way
  the mouth closes. Colours are the theme's dental tokens; nothing here is a hex.

  Planned work is drawn outlined and dashed, done work solid — the same red/blue
  convention dentists already read, with a second cue that survives colour
  blindness and a black-and-white printout.
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
};
export const SOFT: Record<Paint, string> = {
  planned: "var(--color-dental-planned-soft)",
  done: "var(--color-dental-done-soft)",
  existing: "var(--color-dental-existing-soft)",
  finding: "var(--color-dental-finding-soft)",
};

const LINE = "var(--color-tooth-line)";

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

function gumPath(): string {
  return `M 0 ${Y0 - 18} L ${CW} ${Y0 - 18} L ${CW} ${Y0 + 9} C ${CW - 6} ${Y0 + 9} ${C + 9} ${Y0 + 1} ${C} ${Y0 + 1} C ${C - 9} ${Y0 + 1} 6 ${Y0 + 9} 0 ${Y0 + 9} Z`;
}
function gumMargin(): string {
  return `M 0 ${Y0 + 9} C 6 ${Y0 + 9} ${C - 9} ${Y0 + 1} ${C} ${Y0 + 1} C ${C + 9} ${Y0 + 1} ${CW - 6} ${Y0 + 9} ${CW} ${Y0 + 9}`;
}

/** The one copy of the gradients every tooth on the page paints with. */
export function DentalDefs() {
  return (
    <svg width="0" height="0" aria-hidden className="absolute" focusable="false">
      <defs>
        <linearGradient id={`${DEFS}-enamel`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--color-tooth-shade)" }} />
          <stop offset="0.32" style={{ stopColor: "var(--color-tooth-enamel)" }} />
          <stop offset="0.62" style={{ stopColor: "var(--color-tooth-enamel)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-tooth-shade)" }} />
        </linearGradient>
        <linearGradient id={`${DEFS}-root`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--color-tooth-root-shade)" }} />
          <stop offset="0.45" style={{ stopColor: "var(--color-tooth-root)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-tooth-root-shade)" }} />
        </linearGradient>
        <linearGradient id={`${DEFS}-gum`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--color-gum)", stopOpacity: 0 }} />
          <stop offset="0.55" style={{ stopColor: "var(--color-gum)", stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: "var(--color-gum)", stopOpacity: 0.95 }} />
        </linearGradient>
        <radialGradient id={`${DEFS}-top`} cx="0.42" cy="0.38" r="0.75">
          <stop offset="0" style={{ stopColor: "var(--color-tooth-enamel)" }} />
          <stop offset="0.7" style={{ stopColor: "var(--color-tooth-enamel)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-tooth-shade)" }} />
        </radialGradient>
        <pattern id={`${DEFS}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" style={{ stroke: "var(--color-dental-finding)", strokeWidth: 1, opacity: 0.45 }} />
        </pattern>
      </defs>
    </svg>
  );
}

const dashed = (p: Paint) => (p === "planned" ? "3 2" : undefined);

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

function SidePatch({ t, s, sf }: { t: Tooth; s: Shape; sf: Surface }) {
  const mesialRight = t.side === "right";
  const onRight = (sf === "M") === mesialRight;
  switch (sf) {
    case "O":
      return <rect x={0} y={YE - 9} width={CW} height={12} />;
    case "B":
      return <ellipse cx={C} cy={86} rx={s.mw * 0.5} ry={6.5} />;
    case "L":
      return <ellipse cx={C} cy={86} rx={s.mw * 0.36} ry={4.5} opacity={0.4} />;
    default:
      return onRight ? <rect x={C + s.mw - 8} y={YB - 8} width={12} height={30} /> : <rect x={C - s.mw - 4} y={YB - 8} width={12} height={30} />;
  }
}

function SideLayer({ l, t, s, crown, roots, clip }: { l: Layer; t: Tooth; s: Shape; crown: string; roots: Roots; clip: string }) {
  const ink = INK[l.paint];
  const soft = SOFT[l.paint];
  const solid = l.paint !== "planned";
  const dash = dashed(l.paint);
  switch (l.look) {
    case "filling":
    case "inlay":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`} style={{ fill: solid ? ink : soft, fillOpacity: solid ? 0.82 : 1, stroke: ink, strokeWidth: l.look === "inlay" ? 1.6 : 1 }} strokeDasharray={dash}>
          {l.surfaces.map((sf) => (
            <SidePatch key={sf} t={t} s={s} sf={sf} />
          ))}
        </g>
      );
    case "caries":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`} style={{ fill: "var(--color-dental-caries)" }}>
          {l.surfaces.map((sf) => {
            const [x, y] = sideSpot(t, s, sf);
            return (
              <g key={sf} opacity={sf === "L" ? 0.45 : 0.9}>
                <circle cx={x} cy={y} r={3} />
                <circle cx={x + 1.8} cy={y + 1.4} r={1.6} />
              </g>
            );
          })}
        </g>
      );
    case "sealant":
      return <rect className="tooth-pop" clipPath={`url(#${clip})`} x={0} y={YE - 4} width={CW} height={6} style={{ fill: soft, stroke: ink, strokeWidth: 0.8 }} strokeDasharray={dash} />;
    case "core":
      return <rect className="tooth-pop" x={C - s.nw * 0.6} y={Y0 + 1} width={s.nw * 1.2} height={17} rx={3} style={{ fill: solid ? ink : soft, fillOpacity: solid ? 0.75 : 1, stroke: ink, strokeWidth: 1 }} strokeDasharray={dash} />;
    case "post":
      return (
        <g className="tooth-pop" style={{ stroke: ink }}>
          <line x1={C} y1={Y0 + 8} x2={C} y2={Y0 - (Y0 - s.apex) * 0.55} strokeWidth={3.4} strokeLinecap="round" strokeDasharray={dash} />
          <rect x={C - s.nw * 0.6} y={Y0 + 1} width={s.nw * 1.2} height={15} rx={3} style={{ fill: solid ? ink : soft, fillOpacity: solid ? 0.7 : 1, strokeWidth: 1 }} />
        </g>
      );
    case "pulp":
      return <path className="tooth-pop" d={chamberPath(s)} style={{ fill: solid ? ink : soft, fillOpacity: solid ? 0.85 : 1, stroke: ink, strokeWidth: 1 }} strokeDasharray={dash} />;
    case "rct": {
      const want = Number(l.detail.canals) || roots.canals.length;
      const canals = [...roots.canals];
      // More canals than the drawing has roots: a second canal in the first root.
      for (let i = canals.length; i < want; i++) {
        const [x1, y1, x2, y2] = roots.canals[0];
        canals.push([x1 + 1.8 * (i % 2 ? 1 : -1), y1, x2 + 2.4 * (i % 2 ? 1 : -1), y2 + 2]);
      }
      return (
        <g className="tooth-pop" style={{ stroke: ink }}>
          <path d={chamberPath(s)} style={{ fill: solid ? ink : soft, fillOpacity: solid ? 0.85 : 1, strokeWidth: 1 }} />
          {canals.slice(0, Math.max(want, 1)).map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={2.3} strokeLinecap="round" strokeDasharray={dash} />
          ))}
        </g>
      );
    }
    case "apico":
      return (
        <g className="tooth-pop" style={{ stroke: ink }}>
          {roots.apices.map(([x, y], i) => (
            <line key={i} x1={x - 4.5} y1={y + 6} x2={x + 4.5} y2={y + 6} strokeWidth={2.2} strokeLinecap="round" strokeDasharray={dash} />
          ))}
        </g>
      );
    case "crown":
    case "denture":
      return (
        <g className="tooth-pop">
          {l.look === "denture" && (
            <rect x={C - s.mw - 1} y={Y0 - 7} width={s.mw * 2 + 2} height={11} rx={3.5} style={{ fill: "var(--color-gum)", stroke: ink, strokeWidth: 0.9 }} strokeDasharray={dash} />
          )}
          <path d={crown} style={{ fill: soft, stroke: ink, strokeWidth: 1.9 }} strokeDasharray={dash} />
          {solid && (
            <path d={`M ${C - s.mw + 4} ${YB - 2} Q ${C - s.mw + 5} ${YB + 12} ${C - s.mw + 9} ${YE - 6}`} style={{ fill: "none", stroke: "white", strokeWidth: 1.6, opacity: 0.75 }} strokeLinecap="round" />
          )}
        </g>
      );
    case "veneer":
      return (
        <path
          className="tooth-pop"
          d={crown}
          transform={`translate(${C} 87) scale(0.8) translate(${-C} -87)`}
          style={{ fill: soft, stroke: ink, strokeWidth: 1.6 }}
          strokeDasharray={dash}
        />
      );
    case "implant": {
      const top = Y0 - 1;
      const bot = s.apex + 6;
      const threads: number[] = [];
      for (let y = top - 6; y > bot + 4; y -= 5.5) threads.push(y);
      return (
        <g className="tooth-pop" style={{ stroke: ink }}>
          <path d={`M ${C - 5.5} ${top} L ${C + 5.5} ${top} L ${C + 4} ${bot + 5} Q ${C} ${bot - 1} ${C - 4} ${bot + 5} Z`} style={{ fill: soft, strokeWidth: 1.4 }} strokeDasharray={dash} />
          {threads.map((y) => {
            const k = (top - y) / (top - bot);
            const w = 5.6 - k * 1.6;
            return <line key={y} x1={C - w} y1={y} x2={C + w} y2={y - 2.2} strokeWidth={1.1} />;
          })}
          <rect x={C - 3.5} y={top - 1} width={7} height={9} rx={1.5} style={{ fill: ink, strokeWidth: 0 }} opacity={solid ? 0.9 : 0.55} />
        </g>
      );
    }
    case "extraction":
      return (
        <g className="tooth-pop" style={{ stroke: ink }} strokeWidth={2.6} strokeLinecap="round">
          <line x1={C - s.mw - 1} y1={s.apex + 2} x2={C + s.mw + 1} y2={YE} />
          <line x1={C + s.mw + 1} y1={s.apex + 2} x2={C - s.mw - 1} y2={YE} />
        </g>
      );
    case "root":
      return (
        <polyline
          className="tooth-pop"
          points={`${C - s.nw - 1},${Y0 + 1} ${C - s.nw / 2},${Y0 + 5} ${C},${Y0 - 1} ${C + s.nw / 2},${Y0 + 4} ${C + s.nw + 1},${Y0}`}
          style={{ fill: "none", stroke: ink, strokeWidth: 1.8 }}
          strokeLinejoin="round"
        />
      );
    case "fracture":
      return (
        <polyline
          className="tooth-pop"
          points={`${C - s.mw + 3},${YB + 2} ${C - 2},${YB + 10} ${C + 2},${YB + 7} ${C + s.mw - 3},${YB + 17}`}
          style={{ fill: "none", stroke: ink, strokeWidth: 1.9 }}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      );
    case "wear":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          <rect x={0} y={YE - 5} width={CW} height={7} style={{ fill: `url(#${DEFS}-hatch)` }} />
          <line x1={0} y1={YE - 5} x2={CW} y2={YE - 5} style={{ stroke: ink, strokeWidth: 1.4 }} />
        </g>
      );
    case "stain":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`} style={{ fill: ink }}>
          <path d={crown} style={{ fill: soft }} opacity={0.75} />
          <circle cx={C - 4} cy={80} r={1.4} opacity={0.6} />
          <circle cx={C + 3} cy={86} r={1.8} opacity={0.6} />
          <circle cx={C - 1} cy={92} r={1.2} opacity={0.6} />
        </g>
      );
    case "lesion":
      return (
        <g className="tooth-pop" style={{ fill: soft, stroke: ink, strokeWidth: 1.4 }}>
          {roots.apices.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y + 1} r={5.2} />
          ))}
        </g>
      );
    case "furcation":
      return roots.furcation ? (
        <path
          className="tooth-pop"
          d={`M ${roots.furcation[0]} ${roots.furcation[1] - 6} L ${roots.furcation[0] - 4} ${roots.furcation[1] + 1} L ${roots.furcation[0] + 4} ${roots.furcation[1] + 1} Z`}
          style={{ fill: ink }}
        />
      ) : null;
    case "recession":
    case "gum":
      return (
        <path
          className="tooth-pop"
          d={`M ${C - s.nw - 3} ${Y0 - 5} Q ${C} ${Y0 - 13} ${C + s.nw + 3} ${Y0 - 5}`}
          style={{ fill: "none", stroke: ink, strokeWidth: 2 }}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
      );
    case "rotation":
      return (
        <g className="tooth-pop" style={{ fill: "none", stroke: ink, strokeWidth: 1.6 }} strokeLinecap="round">
          <path d={`M ${C - 6} 85 A 6.5 6.5 0 1 1 ${C + 4.8} 90`} />
          <path d={`M ${C + 1.8} 90.5 L ${C + 5} 90.2 L ${C + 5.6} 87`} />
        </g>
      );
    case "graft":
      return (
        <g className="tooth-pop" style={{ fill: ink }}>
          {[
            [C - s.nw - 3, Y0 - 12],
            [C + s.nw + 3, Y0 - 20],
            [C - s.nw - 1.5, Y0 - 28],
            [C + s.nw + 1, Y0 - 9],
            [C - 4, s.apex - 2],
            [C + 4, s.apex],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={1.7} opacity={solid ? 0.9 : 0.6} />
          ))}
        </g>
      );
    case "bracket":
      return (
        <g className="tooth-pop">
          <rect x={C - 4.5} y={81} width={9} height={8} rx={1.6} style={{ fill: ink, stroke: ink }} strokeDasharray={dash} opacity={solid ? 1 : 0.7} />
          <line x1={C - 4.5} y1={85} x2={C + 4.5} y2={85} style={{ stroke: "white", strokeWidth: 1.1 }} />
        </g>
      );
    case "band":
      return <rect className="tooth-pop" x={C - s.mw - 0.5} y={79} width={s.mw * 2 + 1} height={9} rx={2} style={{ fill: soft, stroke: ink, strokeWidth: 1.3 }} strokeDasharray={dash} />;
    case "splint":
      return <line className="tooth-pop" x1={C - s.mw} y1={93} x2={C + s.mw} y2={93} style={{ stroke: ink, strokeWidth: 1.6 }} strokeDasharray="2 1.5" />;
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
  const layers = st.layers.filter((l) => visible(l.paint) && l.look !== "mobility");
  const rootOnly = layers.some((l) => l.look === "root");
  const buried = st.buried && visible(st.buried.paint) ? st.buried : null;
  const flip = t.arch === "lower" ? `matrix(1 0 0 -1 0 ${SIDE_H})` : undefined;
  const move = buried ? `translate(0 ${buried.look === "impacted" ? -19 : -24}) rotate(${buried.look === "impacted" ? (t.side === "right" ? 16 : -16) : 0} ${C} ${Y0 + 12})` : undefined;

  const natural = (
    <g transform={move} opacity={buried ? 0.9 : 1}>
      {roots.back && <path d={roots.back} fill={`url(#${DEFS}-root)`} style={{ stroke: LINE, strokeWidth: 0.8 }} opacity={0.55} />}
      <path d={roots.body} fill={`url(#${DEFS}-root)`} style={{ stroke: rootOnly ? INK.finding : LINE, strokeWidth: rootOnly ? 1.4 : 1 }} />
      <g style={{ stroke: "var(--color-tooth-pulp)", strokeWidth: 1.3 }} opacity={0.55} strokeLinecap="round">
        {roots.canals.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
      {!rootOnly && (
        <>
          <path d={crown} fill={`url(#${DEFS}-enamel)`} style={{ stroke: LINE, strokeWidth: 1 }} />
          <path d={chamberPath(s)} style={{ fill: "var(--color-tooth-pulp)" }} opacity={0.4} />
          {/* The light on the enamel: what makes a drawn tooth read as a tooth. */}
          <path
            d={`M ${C - s.mw + 4.5} ${YB - 3} Q ${C - s.mw + 5} ${YB + 10} ${C - s.mw + 9} ${YE - 7}`}
            style={{ fill: "none", stroke: "white", strokeWidth: 2.2 }}
            strokeLinecap="round"
            opacity={0.85}
          />
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
        </defs>
        {/*
          The gum is drawn over the tooth, not under it: it covers the neck and
          fades out up the root the way soft tissue does, and the papilla sits in
          front of the contact between two crowns.
        */}
        {st.gone ? (
          <g style={{ fill: "none", stroke: "var(--color-ink-300)", strokeWidth: 0.9 }} strokeDasharray="2.5 2">
            <path d={roots.body} />
            <path d={crown} />
          </g>
        ) : (
          natural
        )}
        <path d={gumPath()} fill={`url(#${DEFS}-gum)`} opacity={buried ? 1 : 0.95} />
        {buried && <path d={gumPath()} style={{ fill: "var(--color-gum)" }} opacity={0.35} />}
        <path d={gumMargin()} style={{ fill: "none", stroke: "var(--color-gum-line)", strokeWidth: 0.9 }} opacity={0.85} />
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

function TopLayer({ l, t, outline, clip }: { l: Layer; t: Tooth; outline: string; clip: string }) {
  const ink = INK[l.paint];
  const soft = SOFT[l.paint];
  const solid = l.paint !== "planned";
  const dash = dashed(l.paint);
  switch (l.look) {
    case "filling":
    case "inlay":
    case "sealant": {
      const style = l.look === "sealant" ? { fill: soft, stroke: ink, strokeWidth: 0.8 } : { fill: solid ? ink : soft, fillOpacity: solid ? 0.82 : 1, stroke: ink, strokeWidth: l.look === "inlay" ? 1.6 : 1 };
      const surfaces = l.look === "sealant" ? (["O"] as Surface[]) : l.surfaces;
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          {surfaces.map((sf) => (
            <SurfaceFill key={sf} t={t} outline={outline} sf={sf} style={style} dash={dash} />
          ))}
        </g>
      );
    }
    case "caries":
      return (
        <g className="tooth-pop" style={{ fill: "var(--color-dental-caries)" }}>
          {l.surfaces.map((sf) => {
            const [x, y] = CENTROID[regionOf(t, sf)];
            return (
              <g key={sf}>
                <circle cx={x} cy={y} r={3.1} />
                <circle cx={x + 2.2} cy={y + 1.3} r={1.7} />
                <circle cx={x - 1.8} cy={y + 1.8} r={1.3} />
              </g>
            );
          })}
        </g>
      );
    case "crown":
    case "denture":
      return (
        <g className="tooth-pop" style={{ stroke: ink }} strokeDasharray={dash}>
          <path d={outline} style={{ fill: soft, strokeWidth: 2 }} />
          <path d={outline} transform={INNER} style={{ fill: "none", strokeWidth: 1 }} opacity={0.7} />
        </g>
      );
    case "veneer":
      return (
        <g className="tooth-pop" clipPath={`url(#${clip})`}>
          <SurfaceFill t={t} outline={outline} sf="B" style={{ fill: soft, stroke: ink, strokeWidth: 1.4 }} dash={dash} />
        </g>
      );
    case "rct":
    case "pulp":
    case "post":
    case "core":
      return <circle className="tooth-pop" cx={22} cy={22} r={l.look === "rct" || l.look === "post" ? 3.4 : 2.6} style={{ fill: solid ? ink : soft, stroke: ink, strokeWidth: 1 }} strokeDasharray={dash} />;
    case "implant": {
      const hex = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return `${22 + 3.4 * Math.cos(a)},${22 + 3.4 * Math.sin(a)}`;
      }).join(" ");
      return (
        <g className="tooth-pop" style={{ stroke: ink }}>
          <circle cx={22} cy={22} r={7.5} style={{ fill: soft, strokeWidth: 1.5 }} strokeDasharray={dash} />
          <polygon points={hex} style={{ fill: "none", strokeWidth: 1.2 }} />
        </g>
      );
    }
    case "extraction":
      return (
        <g className="tooth-pop" style={{ stroke: ink }} strokeWidth={2.6} strokeLinecap="round">
          <line x1={7} y1={7} x2={37} y2={37} />
          <line x1={37} y1={7} x2={7} y2={37} />
        </g>
      );
    case "bracket": {
      const y = surfaceAt(t, "top") === "B" ? 6 : 31;
      return <rect className="tooth-pop" x={18} y={y} width={8} height={7} rx={1.5} style={{ fill: ink }} opacity={solid ? 1 : 0.7} />;
    }
    case "band":
      return <path className="tooth-pop" d={outline} style={{ fill: "none", stroke: ink, strokeWidth: 2.8 }} strokeDasharray={dash} />;
    case "fracture":
      return <polyline className="tooth-pop" points="11,13 20,22 24,18 33,31" style={{ fill: "none", stroke: ink, strokeWidth: 1.7 }} strokeLinejoin="round" strokeLinecap="round" />;
    case "wear":
    case "stain":
      return <path className="tooth-pop" d={outline} transform={INNER} style={{ fill: soft, stroke: ink, strokeWidth: 1 }} />;
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
          <path d={outline} fill={`url(#${DEFS}-top)`} style={{ stroke: LINE, strokeWidth: 1 }} />
          <g clipPath={`url(#${clip})`} style={{ stroke: LINE, strokeWidth: 0.6 }} opacity={0.75}>
            <line x1={0} y1={0} x2={44} y2={44} />
            <line x1={44} y1={0} x2={0} y2={44} />
          </g>
          <path d={outline} transform={INNER} fill={`url(#${DEFS}-top)`} style={{ stroke: LINE, strokeWidth: 0.7 / 0.42 }} />
          {!covered && t.kind === "molar" && (
            <path d="M 18.5 22 L 25.5 22 M 22 18.5 L 22 25.5" style={{ stroke: LINE, strokeWidth: 0.6 }} opacity={0.6} />
          )}
          {!covered && t.kind === "premolar" && <path d="M 19 22 L 25 22" style={{ stroke: LINE, strokeWidth: 0.6 }} opacity={0.6} />}
        </>
      )}
      {layers.map((l) => (
        <TopLayer key={l.markId + l.surfaces.join("")} l={l} t={t} outline={outline} clip={clip} />
      ))}
      {picked && picked.length > 0 && (
        <g clipPath={`url(#${clip})`} style={{ fill: "var(--color-brand-500)", fillOpacity: 0.22, stroke: "var(--color-brand-600)", strokeWidth: 1.4 }}>
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
          style={{ fill: paint === "planned" ? SOFT.planned : ink, stroke: ink, strokeWidth: paint === "planned" ? 1.3 : 1 }}
          strokeDasharray={paint === "planned" ? "2 1.4" : undefined}
        />
      )}
    </svg>
  );
}

export { crownPath, rootGeom };
