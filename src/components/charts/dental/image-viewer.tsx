"use client";

/*
  An x-ray or a photo, full screen, the way a dentist reads one: zoom and pan
  to the tooth in question, brighten or add contrast to find a shadow, invert
  to see a root outline the other way round. Next and previous walk the
  patient's images without closing anything.

  Below the image, the teeth it is pinned to. Tapping a tooth number pins or
  unpins it, so the radiograph of 36 opens from 36 next time.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Contrast, Minus, Plus, RotateCcw, Sun, X, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly } from "@/lib/dates";
import { PERMANENT_LOWER, PERMANENT_UPPER } from "@/lib/charts/dental/teeth";

export type ChartImage = {
  id: string;
  src: string;
  name: string;
  kind: "xray" | "photo" | "other";
  mime: string;
  date: string;
  /** Drawn for the preview, not uploaded by anybody. */
  sample?: boolean;
};

export function isPicture(img: ChartImage): boolean {
  return img.mime.startsWith("image/");
}

export function ImageViewer({
  images,
  index,
  pins,
  canPin,
  onIndex,
  onPin,
  onClose,
}: {
  images: ChartImage[];
  index: number;
  pins: Record<string, string[]>;
  canPin: boolean;
  onIndex: (i: number) => void;
  onPin: (imageId: string, fdi: string) => void;
  onClose: () => void;
}) {
  const { t, dir, locale } = useI18n();
  const T = t.dental;
  const img = images[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [bright, setBright] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [invert, setInvert] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setBright(100);
    setContrast(100);
    setInvert(false);
  }, []);
  // A new image opens fitted, at its own exposure.
  useEffect(reset, [index, reset]);

  const go = useCallback((d: number) => onIndex((index + d + images.length) % images.length), [index, images.length, onIndex]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(6, z * 1.25));
      else if (e.key === "-") setZoom((z) => Math.max(1, z / 1.25));
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [go, onClose]);

  if (!img || typeof document === "undefined") return null;
  const pinned = pins[img.id] ?? [];
  const btn = "grid h-9 w-9 place-items-center rounded-ctl text-white/85 hover:bg-white/10 disabled:opacity-35";

  return createPortal(
    <div
      dir={dir}
      lang={locale}
      data-latin-island={dir === "ltr" || undefined}
      role="dialog"
      aria-modal="true"
      aria-label={img.name}
      data-image-viewer
      className="fixed inset-0 z-[60] flex flex-col bg-[rgb(6_8_12)] font-sans text-white animate-fade-in"
    >
      {/* What it is, and the reading tools. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/10 px-3 py-2 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{img.name}</div>
          <div className="text-[12px] text-white/60">
            {T.imageKinds[img.kind]} · {fmtDateOnly(img.date, locale)}
            {img.sample ? ` · ${T.sampleImage}` : ""}
          </div>
        </div>
        {isPicture(img) && (
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" className={btn} onClick={() => setZoom((z) => Math.max(1, z / 1.25))} aria-label={T.zoomOut} disabled={zoom <= 1}>
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-12 text-center text-[12px] tabular-nums text-white/70">{Math.round(zoom * 100)}%</span>
            <button type="button" className={btn} onClick={() => setZoom((z) => Math.min(6, z * 1.25))} aria-label={T.zoomIn} disabled={zoom >= 6}>
              <Plus className="h-4 w-4" />
            </button>
            <label className="ms-1 flex items-center gap-1.5 text-white/70" title={T.brightness}>
              <Sun className="h-4 w-4" />
              <input type="range" min={40} max={200} value={bright} onChange={(e) => setBright(Number(e.target.value))} aria-label={T.brightness} className="w-20 accent-white sm:w-24" />
            </label>
            <label className="flex items-center gap-1.5 text-white/70" title={T.contrast}>
              <Contrast className="h-4 w-4" />
              <input type="range" min={40} max={250} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} aria-label={T.contrast} className="w-20 accent-white sm:w-24" />
            </label>
            <button
              type="button"
              onClick={() => setInvert((v) => !v)}
              aria-pressed={invert}
              className={`h-9 rounded-ctl px-2.5 text-[12.5px] font-semibold ${invert ? "bg-white text-black" : "text-white/85 hover:bg-white/10"}`}
            >
              {T.invert}
            </button>
            <button type="button" className={btn} onClick={reset} aria-label={T.resetView}>
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
        )}
        <button type="button" className={btn} onClick={onClose} aria-label={T.close}>
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* The image: wheel or buttons to zoom, drag to move, double-tap to jump in and back. */}
      <div
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
        onWheel={(e) => setZoom((z) => Math.min(6, Math.max(1, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))}
        onDoubleClick={() => (zoom > 1 ? (setZoom(1), setPan({ x: 0, y: 0 })) : setZoom(2.5))}
        onPointerDown={(e) => {
          if (zoom <= 1) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setPan({ x: d.px + (e.clientX - d.x) / zoom, y: d.py + (e.clientY - d.y) / zoom });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {isPicture(img) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img.src}
            alt={img.name}
            draggable={false}
            className={`absolute inset-0 m-auto max-h-full max-w-full object-contain ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
            style={{
              transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
              filter: `brightness(${bright}%) contrast(${contrast}%)${invert ? " invert(1)" : ""}`,
              transition: drag.current ? "none" : "transform 120ms ease-out",
            }}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <a href={img.src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-ctl bg-white/10 px-4 py-2.5 text-[14px] font-semibold hover:bg-white/20">
              <ExternalLink className="h-4 w-4" />
              {T.openFile}
            </a>
          </div>
        )}
        {images.length > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label={T.previous} className="absolute start-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 hover:bg-black/70">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label={T.next} className="absolute end-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 hover:bg-black/70">
              <ChevronRight className="h-5 w-5" />
            </button>
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-0.5 text-[12px] tabular-nums text-white/80">
              {index + 1} / {images.length}
            </div>
          </>
        )}
      </div>

      {/* The teeth this image is of. */}
      <div className="border-t border-white/10 px-3 py-2.5 sm:px-4" data-pins>
        <div className="mb-1.5 text-[12px] font-semibold text-white/70">{canPin ? T.pinHint : T.pinnedTo}</div>
        <div className="grid gap-1 overflow-x-auto" dir="ltr">
          {[PERMANENT_UPPER, PERMANENT_LOWER].map((row, r) => (
            <div key={r} className="flex gap-1">
              {row.map((fdi, i) => {
                const on = pinned.includes(fdi);
                return (
                  <button
                    key={fdi}
                    type="button"
                    disabled={!canPin}
                    onClick={() => onPin(img.id, fdi)}
                    aria-pressed={on}
                    data-pin={fdi}
                    className={`h-7 min-w-7 shrink-0 rounded-md px-1 text-[11.5px] font-semibold tabular-nums transition-colors ${i === 8 ? "ms-2" : ""} ${
                      on ? "bg-white text-black" : "bg-white/8 text-white/70 hover:bg-white/15"
                    } disabled:cursor-default`}
                  >
                    {fdi}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
