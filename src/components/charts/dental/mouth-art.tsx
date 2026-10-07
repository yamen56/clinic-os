"use client";

/*
  A smile, small enough for a card: lips, a row of upper teeth and a row of
  lower teeth, seen from the front, with the patient's right on the viewer's
  left like the chart above it.

  Work that belongs to the mouth rather than to a tooth — a cleaning, a
  panoramic x-ray, a night guard for the upper arch, deep scaling of one
  quadrant — lights the teeth it covers in its status ink: both rows, one row,
  or one side of one row. The treatment's own icon sits on the corner.

  A front view rather than the two arches from above: at card size the arches
  closed into a ring of beads and read as nothing in particular, while a smile
  reads as a mouth before the eye has finished landing on it.
*/

import { useId } from "react";
import type { LucideIcon } from "lucide-react";
import type { Paint } from "@/lib/charts/dental/state";
import { INK, SOFT } from "./tooth-art";

export type MouthRegion = "mouth" | "upper" | "lower" | "Q1" | "Q2" | "Q3" | "Q4";

const LIPS = "M3 29 C15 7 65 7 77 29 C65 51 15 51 3 29 Z";
const OPENING = "M10 29 C22 15.5 58 15.5 70 29 C58 42.5 22 42.5 10 29 Z";
// Eight teeth a row, widest at the middle: viewer's left half first.
const WIDTHS = [5.6, 6.4, 7.4, 8.6, 8.6, 7.4, 6.4, 5.6];

type Spot = { x: number; w: number; row: "upper" | "lower"; side: "right" | "left" };

const SPOTS: Spot[] = (["upper", "lower"] as const).flatMap((row) => {
  let x = 40 - WIDTHS.reduce((a, b) => a + b, 0) / 2;
  return WIDTHS.map((w, i) => {
    const spot = { x, w, row, side: i < 4 ? ("right" as const) : ("left" as const) };
    x += w;
    return spot;
  });
});

function covers(region: MouthRegion | null, s: Spot): boolean {
  switch (region) {
    case "mouth":
      return true;
    case "upper":
    case "lower":
      return s.row === region;
    case "Q1":
      return s.row === "upper" && s.side === "right";
    case "Q2":
      return s.row === "upper" && s.side === "left";
    case "Q3":
      return s.row === "lower" && s.side === "left";
    case "Q4":
      return s.row === "lower" && s.side === "right";
    default:
      return false;
  }
}

export function MouthGlyph({
  region,
  paint,
  icon: Icon,
  size = 64,
  x,
  y,
}: {
  /** What the work covers; null draws an empty smile (the "add" card). */
  region: MouthRegion | null;
  paint: Paint | null;
  icon: LucideIcon;
  size?: number;
  /** Placed inside another drawing — a label on the chart. */
  x?: number;
  y?: number;
}) {
  const clip = `mouth-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ink = paint ? INK[paint] : "var(--color-brand-600)";
  const soft = paint ? SOFT[paint] : "var(--color-brand-50)";
  const dash = paint === "planned" ? "1.4 1" : undefined;
  return (
    <svg viewBox="0 0 80 60" x={x} y={y} width={size} height={size * 0.75} aria-hidden className="shrink-0 overflow-visible">
      <defs>
        <clipPath id={clip}>
          <path d={OPENING} />
        </clipPath>
      </defs>
      <path d={LIPS} style={{ fill: "var(--color-gum)", stroke: "var(--color-gum-line)", strokeWidth: 1.2 }} />
      <path d={OPENING} style={{ fill: "var(--color-ink-900)" }} />
      <g clipPath={`url(#${clip})`}>
        {SPOTS.map((s, i) => {
          const lit = covers(region, s);
          const y = s.row === "upper" ? 14 : 29.8;
          return (
            <rect
              key={i}
              x={s.x + 0.35}
              y={y}
              width={s.w - 0.7}
              height={s.row === "upper" ? 14.6 : 13}
              rx={1.6}
              style={
                lit
                  ? { fill: paint === "planned" ? soft : ink, stroke: paint === "planned" ? ink : "white", strokeWidth: 0.7 }
                  : { fill: "var(--color-tooth-enamel)", stroke: "var(--color-tooth-line)", strokeWidth: 0.5 }
              }
              strokeDasharray={lit ? dash : undefined}
            />
          );
        })}
      </g>
      <path d={OPENING} style={{ fill: "none", stroke: "var(--color-gum-line)", strokeWidth: 1 }} />
      <circle cx={68} cy={49} r={9.5} style={{ fill: "white", stroke: ink, strokeWidth: 1.3 }} strokeDasharray={dash} />
      <circle cx={68} cy={49} r={7.6} style={{ fill: soft }} />
      <Icon x={62.5} y={43.5} width={11} height={11} color={ink} strokeWidth={2.4} />
    </svg>
  );
}
