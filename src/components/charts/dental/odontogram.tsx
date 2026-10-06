"use client";

/*
  The whole mouth: both arches, each tooth from the side and from above, its
  number between the two. One SVG, so the chart scales as a picture to whatever
  width it is given; on a phone the same SVG is cropped to one half of the mouth
  by moving its viewBox, which keeps every tooth a finger's width wide.

  Always left-to-right, in Arabic too: this is a picture of a mouth seen from
  the dentist's chair, not a line of text.

  Each tooth is its own memoised cell. A tap changes one or two teeth — the one
  selected and the one let go — and those are the only ones redrawn; the other
  fifty keep their drawing. That is what makes the tooth answer the finger.
*/

import { memo, useMemo, useRef } from "react";
import { PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, tooth, toothName, type Arch, type Dentition, type Surface } from "@/lib/charts/dental/teeth";
import { stateOf, type Paint, type ToothState } from "@/lib/charts/dental/state";
import type { Category } from "@/lib/charts/dental/catalog";
import { CW, INK, OCC, SIDE_H, SOFT, ToothSide, ToothTop } from "./tooth-art";
import { iconFor } from "./icons";
import type { MouthRegion } from "./mouth-art";

const MG = 12; // the gap at the midline
const NUM = 18; // the row the tooth numbers sit in
export const CHART_W = 16 * CW + MG;

type Row = { arch: Arch; teeth: string[]; firstCol: number; scale: number };

/** The rows of teeth for a dentition, top to bottom. Also what the arrow keys walk. */
export function rowsFor(d: Dentition): { upper: Row[]; lower: Row[] } {
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

/** The tooth an arrow key leads to from `fdi`, or null at the edge. */
export function neighbour(fdi: string, key: string, d: Dentition): string | null {
  const { upper, lower } = rowsFor(d);
  const rows = [...upper, ...lower];
  const r = rows.findIndex((row) => row.teeth.includes(fdi));
  if (r < 0) return null;
  const i = rows[r].teeth.indexOf(fdi);
  if (key === "ArrowLeft") return rows[r].teeth[i - 1] ?? null;
  if (key === "ArrowRight") return rows[r].teeth[i + 1] ?? null;
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  const target = rows[key === "ArrowUp" ? r - 1 : r + 1];
  if (!target) return null;
  // Same column if there is a tooth there, otherwise the nearest one.
  const col = rows[r].firstCol + i;
  const j = Math.min(Math.max(col - target.firstCol, 0), target.teeth.length - 1);
  return target.teeth[j];
}

const colX = (col: number) => col * CW + (col >= 8 ? MG : 0);

type Placed = { fdi: string; x: number; s: number; sideY: number; numY: number; occY: number; top: number; bottom: number; arch: Arch; col: number };

function layout(d: Dentition): { placed: Placed[]; rows: Placed[][]; height: number; plane: number } {
  const { upper, lower } = rowsFor(d);
  const rows: Placed[][] = [];
  let y = 6;
  for (const r of upper) {
    const s = r.scale;
    const sideY = y;
    const numY = sideY + SIDE_H * s;
    const occY = numY + NUM;
    rows.push(r.teeth.map((fdi, i) => ({ fdi, x: colX(r.firstCol + i), s, sideY, numY, occY, top: sideY, bottom: occY + OCC * s, arch: r.arch, col: r.firstCol + i })));
    y = occY + OCC * s + 10;
  }
  const plane = y + 2;
  y += 10;
  for (const r of lower) {
    const s = r.scale;
    const occY = y;
    const numY = occY + OCC * s;
    const sideY = numY + NUM;
    rows.push(r.teeth.map((fdi, i) => ({ fdi, x: colX(r.firstCol + i), s, sideY, numY, occY, top: occY, bottom: sideY + SIDE_H * s, arch: r.arch, col: r.firstCol + i })));
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

type Handlers = {
  onTooth: (fdi: string, additive: boolean) => void;
  onSurface: (fdi: string, s: Surface, additive: boolean) => void;
  categoryOf: (key: string) => Category | undefined;
};

/*
  A tooth's badge: work that has no shape on the tooth — an x-ray, a vitality
  test, a dry socket dressing — as its group's icon on a small tile beside the
  number, inked by status. A second piece of work adds a count, not a second
  tile, so the row of numbers stays a row of numbers.
*/
function Badge({ x, y, st, visible, categoryOf }: { x: number; y: number; st: ToothState; visible: (p: Paint) => boolean; categoryOf: Handlers["categoryOf"] }) {
  const shown = st.badges.filter((b) => visible(b.paint));
  if (shown.length === 0) return null;
  const last = shown[shown.length - 1];
  const Icon = iconFor(categoryOf(last.treatmentKey));
  const ink = INK[last.paint];
  return (
    <g className="tooth-pop" data-badge={shown.length}>
      <rect x={x} y={y} width={12} height={12} rx={3.2} style={{ fill: SOFT[last.paint], stroke: ink, strokeWidth: 0.8 }} strokeDasharray={last.paint === "planned" ? "1.6 1.2" : undefined} />
      <Icon x={x + 2} y={y + 2} width={8} height={8} color={ink} strokeWidth={2.6} />
      {shown.length > 1 && (
        <text x={x + 13.5} y={y + 4.5} fontSize={6.5} fontWeight={700} style={{ fill: ink, fontFamily: "var(--font-sans)" }}>
          {shown.length}
        </text>
      )}
    </g>
  );
}

const ToothCell = memo(function ToothCell({
  p,
  st,
  isSel,
  visible,
  locale,
  handlers,
}: {
  p: Placed;
  st: ToothState;
  isSel: boolean;
  visible: (p: Paint) => boolean;
  locale: string;
  handlers: React.RefObject<Handlers>;
}) {
  const t = tooth(p.fdi);
  const hasBadge = st.badges.some((b) => visible(b.paint));
  const numX = p.x + CW / 2 - (hasBadge ? 5 : 0);
  const shift = (CW * (1 - p.s)) / 2;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${p.fdi} ${toothName(t, locale)}`}
      aria-pressed={isSel}
      data-tooth={p.fdi}
      data-gone={st.gone || undefined}
      onClick={(e) => handlers.current.onTooth(p.fdi, e.shiftKey || e.metaKey || e.ctrlKey)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handlers.current.onTooth(p.fdi, e.shiftKey);
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
      <g transform={`translate(${p.x + shift} ${p.sideY}) scale(${p.s})`}>
        <ToothSide t={t} st={st} uid="ch" visible={visible} />
      </g>
      <g transform={`translate(${p.x + shift} ${p.occY}) scale(${p.s})`}>
        <ToothTop
          t={t}
          st={st}
          uid="ch"
          visible={visible}
          onSurface={(s, e) => {
            e.stopPropagation();
            handlers.current.onSurface(p.fdi, s, e.shiftKey || e.metaKey || e.ctrlKey);
          }}
        />
      </g>
      {/* The number: a pill when selected, plain otherwise. */}
      {isSel && <rect x={numX - 11} y={p.numY + 2.5} width={22} height={NUM - 5} rx={6.5} className="fill-brand-600" />}
      <text
        x={numX}
        y={p.numY + NUM / 2 + 4}
        textAnchor="middle"
        fontSize={p.s < 1 ? 9.5 : 11}
        fontWeight={isSel ? 700 : 600}
        className={`tnum ${isSel ? "fill-white" : "fill-ink-500"}`}
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {p.fdi}
      </text>
      <Badge x={numX + 12} y={p.numY + 3} st={st} visible={visible} categoryOf={handlers.current.categoryOf} />
    </g>
  );
});

export function Odontogram({
  dentition,
  states,
  visible,
  selected,
  half,
  locale,
  brush,
  highlight,
  onTooth,
  onSurface,
  categoryOf,
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
  /** A whole-mouth card being pointed at: the part of the chart it covers. */
  highlight: MouthRegion | null;
  onTooth: (fdi: string, additive: boolean) => void;
  onSurface: (fdi: string, s: Surface, additive: boolean) => void;
  categoryOf: (key: string) => Category | undefined;
}) {
  const { placed, rows, height, plane } = useMemo(() => layout(dentition), [dentition]);
  // The latest handlers behind a stable reference, so the memoised cells do
  // not redraw just because the parent made new functions this render.
  const handlers = useRef<Handlers>({ onTooth, onSurface, categoryOf });
  handlers.current = { onTooth, onSurface, categoryOf };

  const x0 = half === "left" ? 8 * CW + MG - 2 : -2;
  const w = half ? 8 * CW + 4 : CHART_W + 4;
  const midX = 8 * CW + MG / 2;

  // The frame around what a whole-mouth card covers.
  const frame = (() => {
    if (!highlight) return null;
    const arches = highlight === "mouth" ? ["upper", "lower"] : highlight === "upper" || highlight === "Q1" || highlight === "Q2" ? ["upper"] : ["lower"];
    const inArch = placed.filter((p) => arches.includes(p.arch));
    const top = Math.min(...inArch.map((p) => p.top)) - 6;
    const bottom = Math.max(...inArch.map((p) => p.bottom)) + 6;
    const right = highlight === "Q1" || highlight === "Q4";
    const left = highlight === "Q2" || highlight === "Q3";
    const fx = left ? 8 * CW + MG - 3 : -1;
    const fw = right || left ? 8 * CW + 4 : CHART_W + 2;
    return { x: fx, y: top, w: fw, h: bottom - top };
  })();

  return (
    <svg
      viewBox={`${x0} 0 ${w} ${height}`}
      className={`block h-auto w-full select-none ${brush ? "cursor-crosshair" : ""}`}
      role="group"
      style={{ touchAction: "pan-y" }}
    >
      {frame && (
        <rect
          x={frame.x}
          y={frame.y}
          width={frame.w}
          height={frame.h}
          rx={16}
          className="animate-fade-in"
          style={{ fill: "var(--color-brand-50)", stroke: "var(--color-brand-400)", strokeWidth: 1.4 }}
          strokeDasharray="5 4"
          data-highlight={highlight}
        />
      )}
      {/* The midline and the biting plane, faint: orientation, not decoration. */}
      <line x1={midX} y1={0} x2={midX} y2={height} style={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }} strokeDasharray="3 4" />
      <line x1={0} y1={plane} x2={CHART_W} y2={plane} style={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }} strokeDasharray="3 4" />

      {placed.map((p) => (
        <ToothCell key={p.fdi} p={p} st={stateOf(states, p.fdi)} isSel={selected.includes(p.fdi)} visible={visible} locale={locale} handlers={handlers} />
      ))}

      {/* Bridges, splints and wires, drawn last so they cross the gaps between teeth. */}
      {rows.map((row) =>
        row.slice(0, -1).map((a, i) => {
          const b = row[i + 1];
          const js = joins(stateOf(states, a.fdi), stateOf(states, b.fdi), visible);
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
