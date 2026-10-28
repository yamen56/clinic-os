"use client";

/*
  The face, and the parts of it a doctor taps.

  The picture is a mannequin head (public/charts/face/face-front.webp): real
  in shape, nobody's face. Each part of the face is a button laid over it at
  its place on the picture, so it is reached by Tab and read by a screen
  reader like any other control. A part already treated is tinted in the
  colour of the last kind of work done there — the area itself, not a dot
  beside it (Yamen, 2026-10-28: "use colors but without those circles").

  Paper that stays white in the dark theme: the picture has a white ground.
*/

import { FACE_ZONES, FAMILY_COLOR, type Family } from "@/lib/charts/face/catalog";

export const FACE_SRC = "/charts/face/face-front.webp";

export function FaceMap({
  selected,
  tints,
  showAreas,
  onToggle,
  labels,
}: {
  selected: string[];
  /** The kind of work last done on each part, by zone. */
  tints: Map<string, Family>;
  /** Outline every part, so a new doctor sees where to tap. */
  showAreas: boolean;
  onToggle: (zone: string) => void;
  labels: { right: string; left: string };
}) {
  return (
    <div className="theme-light mx-auto w-full max-w-[420px]">
      <div className="relative w-full rounded-ctl bg-surface" style={{ aspectRatio: "945 / 1264" }} data-face-map>
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed local picture, drawn under buttons placed by percentage */}
        <img src={FACE_SRC} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none rounded-ctl" />
        {FACE_ZONES.map((z) => {
          const on = selected.includes(z.key);
          const tint = tints.get(z.key);
          return (
            <button
              key={z.key}
              type="button"
              onClick={() => onToggle(z.key)}
              aria-pressed={on}
              aria-label={z.en}
              title={z.en}
              data-zone={z.key}
              data-tint={tint}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-140 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                on
                  ? "border-2 border-brand-600 bg-brand-600/20 shadow-[0_0_0_3px_rgba(255,255,255,0.75)]"
                  : tint
                    ? "border-[1.5px] hover:brightness-95"
                    : `border-[1.5px] hover:border-solid hover:border-ink-900/60 hover:bg-ink-900/10 ${showAreas ? "border-dashed border-ink-900/35" : "border-transparent"}`
              }`}
              style={{
                left: `${z.x * 100}%`,
                top: `${z.y * 100}%`,
                // Never smaller than a fingertip, however small the part.
                width: `max(${z.w * 100}%, 30px)`,
                height: `max(${z.h * 100}%, 30px)`,
                ...(tint && !on ? { background: `${FAMILY_COLOR[tint]}47`, borderColor: `${FAMILY_COLOR[tint]}d9` } : {}),
              }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between px-1 text-[12px] text-ink-500">
        <span>{labels.right}</span>
        <span>{labels.left}</span>
      </div>
    </div>
  );
}
