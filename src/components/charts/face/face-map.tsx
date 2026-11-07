"use client";

/*
  The face, and the exact spots a doctor worked on.

  The picture is a mannequin head (public/charts/face/face-front.webp): real
  in shape, nobody's face. A tap puts a point exactly where it lands, and the
  part of the face it is in follows from where that is (Yamen, 2026-11-08: "add
  a point instead of choosing a whole area"). A new point is tapped again to
  take it off. Points from past visits stay on the face in the colour of the
  work done there, and tapping one shows what was done (the chart draws that
  card, as `children`).

  The parts of the face are still buttons laid over the picture at their
  places, so Tab and a screen reader reach them; from the keyboard a part is
  chosen whole, as the quick picks choose whole parts. A part treated before
  without points marked is tinted, as it was.

  Paper that stays white in the dark theme: the picture has a white ground.
*/

import type { ReactNode } from "react";
import { FACE_ZONES, FAMILY_COLOR, zoneAt, type Family } from "@/lib/charts/face/catalog";

export const FACE_SRC = "/charts/face/face-front.webp";

export type PendingPoint = { x: number; y: number; zone: string };
export type PastPoint = { key: string; markId: string; x: number; y: number; family: Family };

export function FaceMap({
  selected,
  points,
  past,
  pastActive,
  openKey,
  tints,
  showAreas,
  onToggle,
  onPoint,
  onRemovePoint,
  onPast,
  labels,
  children,
}: {
  selected: string[];
  /** The points being recorded now. */
  points: PendingPoint[];
  /** Points from the treatments already recorded. */
  past: PastPoint[];
  /** Whether a past point answers a tap; not while new ones are being placed. */
  pastActive: boolean;
  /** The past point whose card is open. */
  openKey: string | null;
  /** The kind of work last done on each part, by zone, for parts treated without points. */
  tints: Map<string, Family>;
  /** Outline every part, so a new doctor sees where things are. */
  showAreas: boolean;
  onToggle: (zone: string) => void;
  onPoint: (p: PendingPoint) => void;
  onRemovePoint: (index: number) => void;
  onPast: (p: PastPoint) => void;
  labels: { right: string; left: string; removePoint: string; pastPoint: string };
  children?: ReactNode;
}) {
  const place = (e: React.MouseEvent<HTMLElement>, box: HTMLElement) => {
    const r = box.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const zone = zoneAt(x, y);
    if (zone) onPoint({ x, y, zone });
  };

  return (
    <div className="theme-light mx-auto w-full max-w-[420px]">
      <div
        className="relative w-full cursor-crosshair touch-manipulation rounded-ctl bg-surface"
        style={{ aspectRatio: "945 / 1264" }}
        onClick={(e) => {
          // A click on the picture itself, outside every part's button.
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.faceImg !== undefined) place(e, e.currentTarget);
        }}
        data-face-map
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed local picture, drawn under buttons placed by percentage */}
        <img src={FACE_SRC} alt="" draggable={false} className="absolute inset-0 h-full w-full select-none rounded-ctl" data-face-img />
        {FACE_ZONES.map((z) => {
          const on = selected.includes(z.key);
          const tint = tints.get(z.key);
          return (
            <button
              key={z.key}
              type="button"
              onClick={(e) => {
                // From the keyboard (no pointer, so no place on the face): the whole part.
                if (e.detail === 0) return onToggle(z.key);
                place(e, e.currentTarget.parentElement!);
              }}
              aria-pressed={on}
              aria-label={z.en}
              title={z.en}
              data-zone={z.key}
              data-tint={tint}
              className={`absolute -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full transition-colors duration-140 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                on
                  ? "border-2 border-brand-600/70 bg-brand-600/10"
                  : tint
                    ? "border-[1.5px] hover:brightness-95"
                    : `border-[1.5px] hover:border-solid hover:border-ink-900/40 hover:bg-ink-900/5 ${showAreas ? "border-dashed border-ink-900/30" : "border-transparent"}`
              }`}
              style={{
                left: `${z.x * 100}%`,
                top: `${z.y * 100}%`,
                // Never smaller than a fingertip, however small the part.
                width: `max(${z.w * 100}%, 30px)`,
                height: `max(${z.h * 100}%, 30px)`,
                ...(tint && !on ? { background: `${FAMILY_COLOR[tint]}40`, borderColor: `${FAMILY_COLOR[tint]}cc` } : {}),
              }}
            />
          );
        })}

        {/* Before: what was done where, each spot in the colour of its kind of work. */}
        {past.map((p) => {
          const open = openKey === p.key;
          return (
            <button
              key={p.key}
              type="button"
              tabIndex={pastActive ? 0 : -1}
              onClick={(e) => {
                e.stopPropagation();
                onPast(p);
              }}
              aria-label={labels.pastPoint}
              className={`absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full ${pastActive ? "" : "pointer-events-none opacity-55"}`}
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, zIndex: open ? 3 : 1 }}
              data-face-past={p.markId}
            >
              <span
                className={`block rounded-full ring-2 ring-white transition-transform ${open ? "h-3.5 w-3.5 scale-125" : "h-2.5 w-2.5"}`}
                style={{ background: FAMILY_COLOR[p.family], boxShadow: open ? `0 0 0 4px ${FAMILY_COLOR[p.family]}55` : undefined }}
              />
            </button>
          );
        })}

        {/* Now: the spots being recorded, tapped again to take one off. */}
        {points.map((p, i) => (
          <button
            key={`${p.x}:${p.y}:${i}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemovePoint(i);
            }}
            aria-label={labels.removePoint}
            className="absolute z-[2] grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            data-face-point={p.zone}
          >
            <span className="block h-3.5 w-3.5 rounded-full bg-brand-600 shadow-[0_0_0_2.5px_white,0_0_0_4px_rgba(11,18,32,0.35)]" />
          </button>
        ))}

        {children}
      </div>
      <div className="mt-1.5 flex justify-between px-1 text-[12px] text-ink-500">
        <span>{labels.right}</span>
        <span>{labels.left}</span>
      </div>
    </div>
  );
}
