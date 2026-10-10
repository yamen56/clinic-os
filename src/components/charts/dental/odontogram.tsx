"use client";

/*
  The whole mouth: both arches, each tooth from the side and from above, its
  number between the two. One SVG, so the chart scales as a picture to whatever
  width it is given; on a phone the same SVG is cropped to one half of the mouth
  by moving its viewBox, which keeps every tooth a finger's width wide.

  Always left-to-right, in Arabic too: this is a picture of a mouth seen from
  the dentist's chair, not a line of text.

  Work that belongs to more than one tooth is on the chart too, where it
  happens: an arch's or a quadrant's work tints the teeth it covers and is
  labelled in a band beside that arch — above the upper teeth, below the lower
  — and the whole mouth's work is labelled in the band between the two arches.
  Each label carries a small smile with its part lit, so "upper right quadrant"
  is seen, not read.

  Each tooth is its own memoised cell. A tap changes one or two teeth — the one
  selected and the one let go — and those are the only ones redrawn; the other
  fifty keep their drawing. That is what makes the tooth answer the finger.
*/

import { memo, useMemo, useRef } from "react";
import { Image as ImageIcon, Plus, type LucideIcon } from "lucide-react";
import { PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, tooth, toothName, type Arch, type Dentition, type Surface } from "@/lib/charts/dental/teeth";
import { stateOf, type Paint, type ToothState } from "@/lib/charts/dental/state";
import type { Category } from "@/lib/charts/dental/catalog";
import { CW, INK, OCC, SIDE_H, SOFT, ToothSide, ToothTop } from "./tooth-art";
import { iconFor } from "./icons";
import { MouthGlyph, type MouthRegion } from "./mouth-art";

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

/* ── Labels for work on the mouth, an arch or a quadrant ───────────────── */

export type RegionMark = { id: string; site: MouthRegion; label: string; title: string; paint: Paint; category: Category | undefined };

const PILL_H = 20;
const PILL_GAP = 5;
const MAX_CHARS = 30;
type Pill = { key: string; x: number; y: number; w: number; text: string; mark: RegionMark | null };

function pillText(label: string): string {
  return label.length > MAX_CHARS ? `${label.slice(0, MAX_CHARS - 1)}…` : label;
}
function pillWidth(text: string): number {
  // Inter at 9.5 units averages a little over half its size per character.
  return 34 + text.length * 5.3;
}

/** Flow labels into centred rows across [x0, x1], starting at y. */
function flow(items: { key: string; text: string; mark: RegionMark | null }[], x0: number, x1: number, y: number): { pills: Pill[]; height: number } {
  if (items.length === 0) return { pills: [], height: 0 };
  const avail = x1 - x0;
  const rows: { key: string; text: string; mark: RegionMark | null; w: number }[][] = [[]];
  let used = 0;
  for (const it of items) {
    const w = Math.min(pillWidth(it.text), avail);
    if (rows[rows.length - 1].length && used + PILL_GAP + w > avail) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push({ ...it, w });
    used += (rows[rows.length - 1].length > 1 ? PILL_GAP : 0) + w;
  }
  const pills: Pill[] = [];
  rows.forEach((row, r) => {
    const rowW = row.reduce((a, p) => a + p.w, 0) + PILL_GAP * (row.length - 1);
    let x = x0 + (avail - rowW) / 2;
    for (const p of row) {
      pills.push({ key: p.key, x, y: y + r * (PILL_H + PILL_GAP), w: p.w, text: p.text, mark: p.mark });
      x += p.w + PILL_GAP;
    }
  });
  return { pills, height: rows.length * PILL_H + (rows.length - 1) * PILL_GAP };
}

type Item = { key: string; text: string; mark: RegionMark | null };

/*
  A band of labels: a quadrant's over its own half of the chart — the upper
  right's on the left, where those teeth are drawn — and an arch's or the
  mouth's across the middle under them. On a phone showing one half, a lane
  whose half is off screen flows across what is visible instead.
*/
function bandFlow(items: Item[], x0: number, x1: number, y: number): { pills: Pill[]; height: number } {
  const mid = 8 * CW + MG / 2;
  const side = (i: Item) => (i.mark && (i.mark.site === "Q1" || i.mark.site === "Q4") ? "right" : i.mark && (i.mark.site === "Q2" || i.mark.site === "Q3") ? "left" : "both");
  const lane = (a: number, b: number): [number, number] => (b - a >= 140 ? [a, b] : [x0, x1]);
  const [lx0, lx1] = lane(Math.max(x0, x0), Math.min(x1, mid - 4));
  const [rx0, rx1] = lane(Math.max(x0, mid + 4), x1);
  const L = flow(items.filter((i) => side(i) === "right"), lx0, lx1, y);
  const shared = lx0 === rx0 && lx1 === rx1;
  const R = flow(items.filter((i) => side(i) === "left"), rx0, rx1, shared ? y + L.height + (L.height ? PILL_GAP : 0) : y);
  const sideH = shared ? L.height + (L.height && R.height ? PILL_GAP : 0) + R.height : Math.max(L.height, R.height);
  const C = flow(items.filter((i) => side(i) === "both"), x0, x1, y + sideH + (sideH ? PILL_GAP : 0));
  return { pills: [...L.pills, ...R.pills, ...C.pills], height: sideH + (C.height ? (sideH ? PILL_GAP : 0) + C.height : 0) };
}

const BAND_OF: Record<MouthRegion, "top" | "center" | "bottom"> = {
  upper: "top",
  Q1: "top",
  Q2: "top",
  mouth: "center",
  lower: "bottom",
  Q3: "bottom",
  Q4: "bottom",
};
// Within a band: the patient's right first, then the whole arch, then the left.
const BAND_ORDER: Record<MouthRegion, number> = { Q1: 0, Q4: 0, upper: 1, lower: 1, mouth: 1, Q2: 2, Q3: 2 };

type Placed = { fdi: string; x: number; s: number; sideY: number; numY: number; occY: number; top: number; bottom: number; arch: Arch; col: number };

function layout(d: Dentition, regions: RegionMark[], addText: string | null, x0: number, x1: number) {
  const { upper, lower } = rowsFor(d);
  const sorted = [...regions].sort((a, b) => BAND_ORDER[a.site] - BAND_ORDER[b.site]);
  const inBand = (b: "top" | "center" | "bottom"): Item[] =>
    sorted.filter((m) => BAND_OF[m.site] === b).map((m) => ({ key: m.id, text: pillText(m.label), mark: m }));
  const centerItems = inBand("center");
  if (addText) centerItems.push({ key: "__add", text: addText, mark: null });

  const rows: Placed[][] = [];
  let y = 6;
  const top = bandFlow(inBand("top"), x0 + 4, x1 - 4, y);
  if (top.height) y += top.height + 10;
  for (const r of upper) {
    const s = r.scale;
    const sideY = y;
    const numY = sideY + SIDE_H * s;
    const occY = numY + NUM;
    rows.push(r.teeth.map((fdi, i) => ({ fdi, x: colX(r.firstCol + i), s, sideY, numY, occY, top: sideY, bottom: occY + OCC * s, arch: r.arch, col: r.firstCol + i })));
    y = occY + OCC * s + 8;
  }
  const center = flow(centerItems, x0 + 4, x1 - 4, y + 6);
  const centerH = Math.max(16, center.height + 12);
  const plane = y + centerH / 2;
  y += centerH + 6;
  for (const r of lower) {
    const s = r.scale;
    const occY = y;
    const numY = occY + OCC * s;
    const sideY = numY + NUM;
    rows.push(r.teeth.map((fdi, i) => ({ fdi, x: colX(r.firstCol + i), s, sideY, numY, occY, top: occY, bottom: sideY + SIDE_H * s, arch: r.arch, col: r.firstCol + i })));
    y = sideY + SIDE_H * s + 8;
  }
  const bottom = bandFlow(inBand("bottom"), x0 + 4, x1 - 4, y + 4);
  if (bottom.height) y += bottom.height + 10;
  return { placed: rows.flat(), rows, height: y - 2, plane, pills: [...top.pills, ...center.pills, ...bottom.pills] };
}

/** The box around what a region covers: an arch, a quadrant, or both arches. */
function regionBox(region: MouthRegion, placed: Placed[]): { x: number; y: number; w: number; h: number } {
  const arches = region === "mouth" ? ["upper", "lower"] : region === "upper" || region === "Q1" || region === "Q2" ? ["upper"] : ["lower"];
  const inArch = placed.filter((p) => arches.includes(p.arch));
  const top = Math.min(...inArch.map((p) => p.top)) - 5;
  const bottom = Math.max(...inArch.map((p) => p.bottom)) + 5;
  const right = region === "Q1" || region === "Q4";
  const left = region === "Q2" || region === "Q3";
  const x = left ? 8 * CW + MG - 3 : -1;
  const w = right || left ? 8 * CW + 4 : CHART_W + 2;
  return { x, y: top, w, h: bottom - top };
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
  onImages: (fdi: string) => void;
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
  images,
  visible,
  locale,
  imagesLabel,
  handlers,
}: {
  p: Placed;
  st: ToothState;
  isSel: boolean;
  /** How many x-rays and photos are pinned to this tooth. */
  images: number;
  visible: (p: Paint) => boolean;
  locale: string;
  imagesLabel: string;
  handlers: React.RefObject<Handlers>;
}) {
  const t = tooth(p.fdi);
  const hasBadge = st.badges.some((b) => visible(b.paint));
  const numX = p.x + CW / 2 - (hasBadge ? 5 : 0);
  const shift = (CW * (1 - p.s)) / 2;
  // The picture badge sits at the root end of the column, out of the tooth's way.
  const imgY = p.arch === "upper" ? p.top - 1 : p.bottom - 13;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${p.fdi} ${toothName(t, locale)}`}
      aria-pressed={isSel}
      data-tooth={p.fdi}
      data-gone={st.gone || undefined}
      data-looks={st.layers.map((l) => l.look).join(" ") || undefined}
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
      {images > 0 && (
        <g
          role="button"
          tabIndex={0}
          aria-label={imagesLabel.replace("{n}", p.fdi)}
          data-tooth-images={images}
          className="tooth-pop cursor-zoom-in"
          onClick={(e) => {
            e.stopPropagation();
            handlers.current.onImages(p.fdi);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              handlers.current.onImages(p.fdi);
            }
          }}
        >
          <rect x={p.x + CW - 17} y={imgY} width={15} height={13} rx={3.2} style={{ fill: "white", stroke: "var(--color-brand-400)", strokeWidth: 0.9 }} />
          <ImageIcon x={p.x + CW - 14.5} y={imgY + 2} width={10} height={9} color="var(--color-brand-600)" strokeWidth={2.4} />
          {images > 1 && (
            <text x={p.x + CW - 1} y={imgY + 4} fontSize={6.5} fontWeight={700} style={{ fill: "var(--color-brand-600)", fontFamily: "var(--font-sans)" }}>
              {images}
            </text>
          )}
        </g>
      )}
    </g>
  );
});

function RegionPill({ pill, onRegion, onHover }: { pill: Pill; onRegion: (id: string | null) => void; onHover: (r: MouthRegion | null) => void }) {
  const m = pill.mark;
  const icon: LucideIcon = m ? iconFor(m.category) : Plus;
  const planned = m?.paint === "planned";
  const activate = () => onRegion(m ? m.id : null);
  return (
    <g
      role="button"
      tabIndex={0}
      data-region-pill={m ? m.site : "add"}
      className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-brand-600"
      onClick={(e) => {
        e.stopPropagation();
        activate();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      onMouseEnter={() => m && onHover(m.site)}
      onMouseLeave={() => m && onHover(null)}
      onFocus={() => m && onHover(m.site)}
      onBlur={() => m && onHover(null)}
    >
      <title>{m ? m.title : pill.text}</title>
      <rect
        x={pill.x}
        y={pill.y}
        width={pill.w}
        height={PILL_H}
        rx={PILL_H / 2}
        style={{ fill: m ? SOFT[m.paint] : "white", stroke: m ? INK[m.paint] : "var(--color-line-strong)", strokeWidth: 1 }}
        strokeDasharray={planned || !m ? "3 2" : undefined}
      />
      <MouthGlyph x={pill.x + 5} y={pill.y + 2.5} size={20} region={m ? m.site : null} paint={m ? m.paint : null} icon={icon} />
      <text
        x={pill.x + 29}
        y={pill.y + 13.4}
        fontSize={9.5}
        fontWeight={600}
        style={{ fill: m ? "var(--color-ink-900)" : "var(--color-brand-600)", fontFamily: "var(--font-sans)" }}
      >
        {pill.text}
      </text>
    </g>
  );
}

export function Odontogram({
  dentition,
  states,
  visible,
  selected,
  half,
  locale,
  brush,
  highlight,
  regions,
  addRegionLabel,
  imageCounts,
  imagesLabel,
  onTooth,
  onSurface,
  onImages,
  onRegion,
  onRegionHover,
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
  /** A region label being pointed at: the part of the chart it covers. */
  highlight: MouthRegion | null;
  /** Work on the mouth, an arch or a quadrant, as it stands on the day shown. */
  regions: RegionMark[];
  /** The "add" label in the middle band; null when nothing may be added (a past day). */
  addRegionLabel: string | null;
  imageCounts: Record<string, number>;
  imagesLabel: string;
  onTooth: (fdi: string, additive: boolean) => void;
  onSurface: (fdi: string, s: Surface, additive: boolean) => void;
  onImages: (fdi: string) => void;
  /** A region label tapped: its id, or null for "add". */
  onRegion: (id: string | null) => void;
  onRegionHover: (r: MouthRegion | null) => void;
  categoryOf: (key: string) => Category | undefined;
}) {
  const x0 = half === "left" ? 8 * CW + MG - 2 : -2;
  const w = half ? 8 * CW + 4 : CHART_W + 4;
  const { placed, rows, height, plane, pills } = useMemo(
    () => layout(dentition, regions, addRegionLabel, x0, x0 + w),
    [dentition, regions, addRegionLabel, x0, w]
  );
  // The latest handlers behind a stable reference, so the memoised cells do
  // not redraw just because the parent made new functions this render.
  const handlers = useRef<Handlers>({ onTooth, onSurface, onImages, categoryOf });
  handlers.current = { onTooth, onSurface, onImages, categoryOf };
  const midX = 8 * CW + MG / 2;

  // Arch and quadrant work tints its teeth; the whole mouth's is labelled, not tinted.
  const tints = regions.filter((m) => m.site !== "mouth");
  const frame = highlight ? regionBox(highlight, placed) : null;

  return (
    <svg
      viewBox={`${x0} 0 ${w} ${height}`}
      className={`block h-auto w-full select-none ${brush ? "cursor-crosshair" : ""}`}
      role="group"
      style={{ touchAction: "pan-y" }}
    >
      {tints.map((m) => {
        const b = regionBox(m.site, placed);
        return (
          <rect
            key={m.id}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={14}
            data-region-tint={m.site}
            style={{ fill: SOFT[m.paint], fillOpacity: 0.55, stroke: INK[m.paint], strokeOpacity: 0.55, strokeWidth: 1.1 }}
            strokeDasharray={m.paint === "planned" ? "5 4" : undefined}
          />
        );
      })}
      {frame && (
        <rect
          x={frame.x}
          y={frame.y}
          width={frame.w}
          height={frame.h}
          rx={16}
          className="animate-fade-in"
          style={{ fill: "var(--color-brand-50)", fillOpacity: 0.6, stroke: "var(--color-brand-400)", strokeWidth: 1.6 }}
          strokeDasharray="5 4"
          data-highlight={highlight}
        />
      )}
      {/* The midline and the biting plane, faint: orientation, not decoration. */}
      <line x1={midX} y1={0} x2={midX} y2={height} style={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }} strokeDasharray="3 4" />
      <line x1={0} y1={plane} x2={CHART_W} y2={plane} style={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }} strokeDasharray="3 4" />

      {placed.map((p) => (
        <ToothCell
          key={p.fdi}
          p={p}
          st={stateOf(states, p.fdi)}
          isSel={selected.includes(p.fdi)}
          images={imageCounts[p.fdi] ?? 0}
          visible={visible}
          locale={locale}
          imagesLabel={imagesLabel}
          handlers={handlers}
        />
      ))}

      {/* Bridges, splints and wires, drawn after the teeth so they cross the gaps between them. */}
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

      {/* The labels for work on the mouth, an arch or a quadrant, last so nothing covers them. */}
      {pills.map((pill) => (
        <RegionPill key={pill.key} pill={pill} onRegion={onRegion} onHover={onRegionHover} />
      ))}
    </svg>
  );
}
