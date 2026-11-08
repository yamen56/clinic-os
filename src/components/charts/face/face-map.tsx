"use client";

/*
  The face, and the exact spots a doctor worked on.

  The picture is a mannequin head, real in shape and nobody's face, from the
  front or turned (public/charts/face/face-*.webp): each view has its own
  picture and its own places for the parts of the face (catalog `zonesOn`).

  The doctor chooses where they worked by dots alone (Yamen, 2026-11-08: "let's
  just depend on the dot"). A tap puts a dot exactly where it lands, and the part
  of the face follows from where that is; a new dot is tapped again to take it
  off. Nothing on the face is an area to pick: the parts are invisible buttons,
  there only so a keyboard can reach them, and Enter on one puts a dot in its
  middle. Dots from past visits stay in the colour of the work done there, and
  tapping one shows what was done (the chart draws that card, as `children`).

  Every dot is on every picture that shows its part, wherever it was marked
  (Yamen, 2026-11-08: "when I put a treatment on the front I want to see it when I
  press on the right"): `placeOn` keeps its place within its part.

  Paper that stays white in the dark theme: the picture has a white ground.
*/

import type { ReactNode } from "react";
import { VIEW_CAPTION, VIEW_NAME, VIEW_SRC, placeOn, zoneAt, zonesOn, type FaceView } from "@/lib/charts/face/catalog";

export type PendingPoint = { x: number; y: number; zone: string; v: FaceView };
/** A recorded spot, where it was marked, and the colour of its treatment. */
export type PastPoint = { key: string; markId: string; zone: string; x: number; y: number; v: FaceView; color: string };

export function FaceMap({
  view,
  points,
  past,
  pastActive,
  openKey,
  onPoint,
  onRemovePoint,
  onPast,
  labels,
  children,
}: {
  /** Which picture: the front, or the head turned. */
  view: FaceView;
  /** The points being recorded now, on every view; only this view's are drawn. */
  points: PendingPoint[];
  /** Points from the treatments already recorded. */
  past: PastPoint[];
  /** Whether a past point answers a tap; not while new ones are being placed. */
  pastActive: boolean;
  /** The past point whose card is open. */
  openKey: string | null;
  onPoint: (p: PendingPoint) => void;
  onRemovePoint: (index: number) => void;
  /** `at` is where it is on the picture in front of the doctor. */
  onPast: (p: PastPoint, at: { x: number; y: number }) => void;
  labels: { right: string; left: string; removePoint: string; pastPoint: string; addPointIn: string };
  children?: ReactNode;
}) {
  const place = (e: React.MouseEvent<HTMLElement>, box: HTMLElement) => {
    const r = box.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const zone = zoneAt(x, y, view);
    if (zone) onPoint({ x, y, zone, v: view });
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
        data-face-view={view}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed local picture, drawn under buttons placed by percentage */}
        <img src={VIEW_SRC[view]} alt={VIEW_NAME[view]} draggable={false} className="absolute inset-0 h-full w-full select-none rounded-ctl" data-face-img />
        {zonesOn(view).map((z) => (
          <button
            key={z.key}
            type="button"
            onClick={(e) => {
              // From the keyboard there is no place on the face: the dot goes in the part's middle.
              if (e.detail === 0) return onPoint({ x: z.x, y: z.y, zone: z.key, v: view });
              place(e, e.currentTarget.parentElement!);
            }}
            aria-label={labels.addPointIn.replace("{area}", z.en)}
            data-zone={z.key}
            className="absolute -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            style={{
              left: `${z.x * 100}%`,
              top: `${z.y * 100}%`,
              width: `max(${z.w * 100}%, 30px)`,
              height: `max(${z.h * 100}%, 30px)`,
            }}
          />
        ))}

        {/* Before: what was done where, each spot in the colour of its kind of work. */}
        {past.map((p) => {
            const at = placeOn(p, p.zone, view);
            if (!at) return null;
            const open = openKey === p.key;
            return (
              <button
                key={p.key}
                type="button"
                tabIndex={pastActive ? 0 : -1}
                onClick={(e) => {
                  e.stopPropagation();
                  onPast(p, at);
                }}
                aria-label={labels.pastPoint}
                className={`absolute grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full ${pastActive ? "" : "pointer-events-none opacity-55"}`}
                style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%`, zIndex: open ? 3 : 1 }}
                data-face-past={p.markId}
              >
                <span
                  className={`block rounded-full ring-2 ring-white transition-transform ${open ? "h-3.5 w-3.5 scale-125" : "h-2.5 w-2.5"}`}
                  style={{ background: p.color, boxShadow: open ? `0 0 0 4px ${p.color}55` : undefined }}
                />
              </button>
            );
          })}

        {/* Now: the spots being recorded, tapped again to take one off. */}
        {points.map((p, i) => {
          const at = placeOn(p, p.zone, view);
          return !at ? null : (
            <button
              key={`${p.x}:${p.y}:${i}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemovePoint(i);
              }}
              aria-label={labels.removePoint}
              // Answers a tap on the dot itself only: crow's feet are injected a few millimetres apart, and a
              // wider target took the next dot's tap as removing this one.
              className="absolute z-[2] grid h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
              style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
              data-face-point={p.zone}
              data-face-point-view={p.v}
            >
              <span className="block h-3.5 w-3.5 rounded-full bg-brand-600 shadow-[0_0_0_2.5px_white,0_0_0_4px_rgba(11,18,32,0.35)]" />
            </button>
          );
        })}

        {children}
      </div>
      {/* Which side is which: across the front, and which side a turned head shows. */}
      {view === "front" ? (
        <div className="mt-1.5 flex justify-between px-1 text-[12px] text-ink-500">
          <span>{labels.right}</span>
          <span>{labels.left}</span>
        </div>
      ) : (
        <div className="mt-1.5 text-center text-[12px] text-ink-500" data-face-view-caption>
          {VIEW_CAPTION[view]}
        </div>
      )}
    </div>
  );
}
