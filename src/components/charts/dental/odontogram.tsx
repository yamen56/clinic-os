"use client";

/*
  The whole mouth: both arches, each tooth from the side and from above, its
  number between the two. One SVG, so the chart scales as a picture to whatever
  width it is given; on a phone the same SVG is cropped to one half of the mouth
  by moving its viewBox, which keeps every tooth a finger's width wide.

  Always left-to-right, in Arabic too: this is a picture of a mouth seen from
  the dentist's chair, not a line of text.
*/

import { PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, tooth, toothName, type Arch, type Dentition, type Surface } from "@/lib/charts/dental/teeth";
import { stateOf, type Paint, type ToothState } from "@/lib/charts/dental/state";
import { CW, INK, OCC, SIDE_H, ToothSide, ToothTop } from "./tooth-art";

const MG = 12; // the gap at the midline
const NUM = 18; // the row the tooth numbers sit in
export const CHART_W = 16 * CW + MG;

type Row = { arch: Arch; teeth: string[]; firstCol: number; scale: number };

function rowsFor(d: Dentition): { upper: Row[]; lower: Row[] } {
  const pu: Row = { arch: "upper", teeth: PERMANENT_UPPER, firstCol: 0, scale: 1 };
  const pl: Row = { arch: "lower", teeth: PERMANENT_LOWER, firstCol: 0, scale: 1 };
  if (d === "permanent") return { upper: [pu], lower: [pl] };
  // Primary teeth stand under the permanent teeth that will replace them:
  // 55 under 15, 51 under 11 — columns 3 to 12.
  if (d === "primary") {
    return {
      upper: [{ arch: "upper", teeth: PRIMARY_UPPER, firstCol: 3, scale: 1 }],
      lower: [{ arch: "lower", teeth: PRIMARY_LOWER, firstCol: 3, scale: 1 }],
    };
  }
  return {
    upper: [pu, { arch: "upper", teeth: PRIMARY_UPPER, firstCol: 3, scale: 0.78 }],
    lower: [{ arch: "lower", teeth: PRIMARY_LOWER, firstCol: 3, scale: 0.78 }, pl],
  };
}

const colX = (col: number) => col * CW + (col >= 8 ? MG : 0);

type Placed = { fdi: string; x: number; s: number; sideY: number; numY: number; occY: number; top: number; bottom: number; arch: Arch };

function layout(d: Dentition): { placed: Placed[]; rows: Placed[][]; height: number; plane: number } {
  const { upper, lower } = rowsFor(d);
  const rows: Placed[][] = [];
  let y = 6;
  for (const r of upper) {
    const s = r.scale;
    const sideY = y;
    const numY = sideY + SIDE_H * s;
    const occY = numY + NUM;
    rows.push(r.teeth.map((fdi, i) => ({ fdi, x: colX(r.firstCol + i), s, sideY, numY, occY, top: sideY, bottom: occY + OCC * s, arch: r.arch })));
    y = occY + OCC * s + 10;
  }
  const plane = y + 2;
  y += 10;
  for (const r of lower) {
    const s = r.scale;
    const occY = y;
    const numY = occY + OCC * s;
    const sideY = numY + NUM;
    rows.push(r.teeth.map((fdi, i) => ({ fdi, x: colX(r.firstCol + i), s, sideY, numY, occY, top: occY, bottom: sideY + SIDE_H * s, arch: r.arch })));
    y = sideY + SIDE_H * s + 10;
  }
  return { placed: rows.flat(), rows, height: y - 4, plane };
}

/** Where two neighbouring teeth are joined: a bridge, a splint, or a wire through brackets. */
function joins(a: ToothState, b: ToothState, visible: (p: Paint) => boolean): { paint: Paint; kind: "bar" | "wire" | "splint" }[] {
  const out: { paint: Paint; kind: "bar" | "wire" | "splint" }[] = [];
  for (const la of a.layers) {
    if (!visible(la.paint)) continue;
    if (la.groupId) {
      const lb = b.layers.find((x) => x.groupId === la.groupId);
      if (lb) out.push({ paint: la.paint, kind: la.look === "splint" ? "splint" : "bar" });
    } else if (la.look === "bracket" && b.layers.some((x) => x.look === "bracket" && visible(x.paint))) {
      out.push({ paint: la.paint, kind: "wire" });
    }
  }
  return out;
}

export function Odontogram({
  dentition,
  states,
  visible,
  selected,
  half,
  locale,
  brush,
  onTooth,
  onSurface,
}: {
  dentition: Dentition;
  states: Map<string, ToothState>;
  visible: (p: Paint) => boolean;
  selected: string[];
  /** On a phone: which half of the mouth to show. */
  half: "right" | "left" | null;
  locale: string;
  /** Brush mode: the cursor says "this paints". */
  brush: boolean;
  onTooth: (fdi: string, additive: boolean) => void;
  onSurface: (fdi: string, s: Surface, additive: boolean) => void;
}) {
  const { placed, rows, height, plane } = layout(dentition);
  const x0 = half === "left" ? 8 * CW + MG - 2 : -2;
  const w = half ? 8 * CW + 4 : CHART_W + 4;
  const midX = 8 * CW + MG / 2;

  return (
    <svg
      viewBox={`${x0} 0 ${w} ${height}`}
      className={`block h-auto w-full select-none ${brush ? "cursor-crosshair" : ""}`}
      role="group"
      style={{ touchAction: "manipulation" }}
    >
      {/* The midline and the biting plane, faint: orientation, not decoration. */}
      <line x1={midX} y1={0} x2={midX} y2={height} style={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }} strokeDasharray="3 4" />
      <line x1={0} y1={plane} x2={CHART_W} y2={plane} style={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }} strokeDasharray="3 4" />

      {placed.map((p) => {
        const t = tooth(p.fdi);
        const st = stateOf(states, p.fdi);
        const isSel = selected.includes(p.fdi);
        const dots = st.dots.filter(visible);
        return (
          <g
            key={p.fdi}
            role="button"
            tabIndex={0}
            aria-label={`${p.fdi} ${toothName(t, locale)}`}
            aria-pressed={isSel}
            data-tooth={p.fdi}
            data-gone={st.gone || undefined}
            onClick={(e) => onTooth(p.fdi, e.shiftKey || e.metaKey || e.ctrlKey)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onTooth(p.fdi, e.shiftKey);
              }
            }}
            className="group cursor-pointer outline-none"
          >
            <rect
              x={p.x + 1}
              y={p.top - 3}
              width={CW - 2}
              height={p.bottom - p.top + 6}
              rx={9}
              className={
                isSel
                  ? "fill-brand-50 stroke-brand-400"
                  : "fill-transparent stroke-transparent group-hover:fill-sunken group-focus-visible:stroke-brand-400"
              }
              strokeWidth={1.2}
            />
            <g transform={`translate(${p.x + (CW * (1 - p.s)) / 2} ${p.sideY}) scale(${p.s})`}>
              <ToothSide t={t} st={st} uid="ch" visible={visible} />
            </g>
            <g transform={`translate(${p.x + (CW * (1 - p.s)) / 2} ${p.occY}) scale(${p.s})`}>
              <ToothTop
                t={t}
                st={st}
                uid="ch"
                visible={visible}
                onSurface={(s, e) => {
                  e.stopPropagation();
                  onSurface(p.fdi, s, e.shiftKey || e.metaKey || e.ctrlKey);
                }}
              />
            </g>
            {/* The number: a pill when selected, plain otherwise. */}
            {isSel && <rect x={p.x + CW / 2 - 12} y={p.numY + 2.5} width={24} height={NUM - 5} rx={6.5} className="fill-brand-600" />}
            <text
              x={p.x + CW / 2}
              y={p.numY + NUM / 2 + 4}
              textAnchor="middle"
              fontSize={p.s < 1 ? 9.5 : 11}
              fontWeight={isSel ? 700 : 600}
              className={`tnum ${isSel ? "fill-white" : "fill-ink-500"}`}
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {p.fdi}
            </text>
            {dots.slice(0, 3).map((paint, i) => (
              <circle key={i} cx={p.x + CW / 2 + 15 + i * 4.5} cy={p.numY + NUM / 2} r={1.9} style={{ fill: INK[paint] }} />
            ))}
          </g>
        );
      })}

      {/* Bridges, splints and wires, drawn last so they cross the gaps between teeth. */}
      {rows.map((row) =>
        row.slice(0, -1).map((a, i) => {
          const b = row[i + 1];
          const sa = stateOf(states, a.fdi);
          const sb = stateOf(states, b.fdi);
          const js = joins(sa, sb, visible);
          if (js.length === 0) return null;
          const xa = a.x + CW / 2;
          const xb = b.x + CW / 2;
          const local = (yUp: number) => (a.arch === "upper" ? a.sideY + yUp * a.s : a.sideY + (SIDE_H - yUp) * a.s);
          return js.map((j, k) => {
            const ink = INK[j.paint];
            const dash = j.paint === "planned" ? "3 2" : undefined;
            if (j.kind === "bar") {
              const y = local(88);
              return <rect key={`${a.fdi}-${k}`} x={xa} y={y - 2.2} width={xb - xa} height={4.4} rx={2} className="tooth-pop" style={{ fill: ink, opacity: 0.85 }} strokeDasharray={dash} />;
            }
            const y = local(j.kind === "wire" ? 85 : 93);
            return (
              <line
                key={`${a.fdi}-${k}`}
                x1={xa}
                y1={y}
                x2={xb}
                y2={y}
                className="tooth-pop"
                style={{ stroke: ink, strokeWidth: j.kind === "wire" ? 1.2 : 1.6 }}
                strokeDasharray={j.kind === "splint" ? "2 1.5" : dash}
              />
            );
          });
        })
      )}
    </svg>
  );
}
