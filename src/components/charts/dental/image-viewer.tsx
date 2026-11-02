"use client";

/*
  An x-ray or a photo, full screen, the way a dentist reads one: zoom and pan
  to the tooth in question, brighten or add contrast to find a shadow, invert
  to see a root outline the other way round. Next and previous walk the
  patient's images without closing anything.

  Below the image, what it is and the teeth it is pinned to. Tapping a tooth
  number pins or unpins it, so the radiograph of 36 opens from 36 next time;
  a panoramic or a CBCT is not of one tooth, so what it is — panoramic,
  bitewing, periapical, occlusal, CBCT, an intraoral photo — is picked in the
  same place (Yamen, 2026-11-02).

  And the tools a doctor reaches for in the imaging software, without leaving
  the file (2026-11-02, lib/imaging/adjust): Adjust — brightness, contrast,
  gamma, sharpness, invert, auto contrast, relief, colour maps, turn and flip
  — and Draw — brush, arrow, line, circle, text, a ruler in millimetres once
  calibrated, an angle. Save writes what is on the screen as a new picture
  beside the original, which is never changed, and Save & send sends it to
  the patient.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  Columns2,
  Contrast,
  Crosshair,
  DraftingCompass,
  Eraser,
  ExternalLink,
  FlipHorizontal2,
  FlipVertical2,
  Hand,
  LoaderCircle,
  MessageCircle,
  Minus,
  MoveUpRight,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Ruler,
  Save,
  Slash,
  SlidersHorizontal,
  Sun,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly } from "@/lib/dates";
import { PERMANENT_LOWER, PERMANENT_UPPER } from "@/lib/charts/dental/teeth";
import { FILE_VIEWS } from "@/lib/imaging/kinds";
import {
  MARK_COLOURS,
  NO_ADJUST,
  angleArc,
  arrowHead,
  dist,
  drawMarks,
  drawOriented,
  isAdjusted,
  labelAt,
  moveMarks,
  orientedSize,
  processPixels,
  rulerTicks,
  strokeUnit,
  type Adjust,
  type Colours,
  type Mark,
  type Pt,
} from "@/lib/imaging/adjust";

export type ChartImage = {
  id: string;
  src: string;
  name: string;
  /** What it is — x-ray, photo, ECG, ultrasound… (lib/imaging/kinds). */
  kind: string;
  /** What a dental picture shows — panoramic, bitewing… (lib/imaging/kinds FILE_VIEWS). */
  view?: string | null;
  mime: string;
  date: string;
  /** Drawn for the preview, not uploaded by anybody. */
  sample?: boolean;
};

export function isPicture(img: ChartImage): boolean {
  return img.mime.startsWith("image/");
}

type Tool = "hand" | "pen" | "arrow" | "line" | "circle" | "text" | "ruler" | "angle" | "erase" | "calibrate";
type Natural = { el: HTMLImageElement; w: number; h: number };

/** The preview is worked at this size at most; Save works the picture's own pixels. */
const PREVIEW_MAX = 1600;
/** Saved copies stay a size WhatsApp and a phone open quickly. */
const SAVE_MAX = 4096;
const SIZES = [1.5, 3, 6] as const;

export function ImageViewer({
  images,
  index,
  pins,
  canPin,
  onIndex,
  onPin,
  onClose,
  onSend,
  showTeeth = true,
  onView,
  onSaveCopy,
}: {
  images: ChartImage[];
  index: number;
  pins: Record<string, string[]>;
  canPin: boolean;
  onIndex: (i: number) => void;
  onPin: (imageId: string, fdi: string) => void;
  onClose: () => void;
  /** Offered when the patient can be messaged: the picture, to their WhatsApp. */
  onSend?: (img: ChartImage) => void;
  /** The tooth row beneath — for a clinic that charts teeth. */
  showTeeth?: boolean;
  /** What the picture shows can be set here — a dental clinic's member who may. */
  onView?: (imageId: string, view: string | null) => void;
  /** Save the edited picture as a new one beside it; answers with the copy, now in `images`. */
  onSaveCopy?: (original: ChartImage, file: File) => Promise<ChartImage | null>;
}) {
  const { t, dir, locale } = useI18n();
  const T = t.viewer;
  const img = images[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  /*
    Before and after: the same teeth, two dates, side by side — one zoom, one
    pan, one exposure for both, so the same spot is compared at the same
    scale. The other image defaults to the latest earlier one of these teeth.
  */
  const [comparing, setComparing] = useState(false);
  const [otherId, setOtherId] = useState<string | null>(null);

  /* The tools: which panel is open, the exposure, the marks and their history. */
  const [panel, setPanel] = useState<null | "adjust" | "draw">(null);
  const [adjust, setAdjust] = useState<Adjust>(NO_ADJUST);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [past, setPast] = useState<Mark[][]>([]);
  const [future, setFuture] = useState<Mark[][]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [colour, setColour] = useState<string>(MARK_COLOURS[0]);
  const [size, setSize] = useState<number>(SIZES[1]);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Mark | null>(null);
  /** An angle's first arm is drawn; the next tap ends the second. */
  const [angleArm, setAngleArm] = useState(false);
  const [mmPerPx, setMmPerPx] = useState<number | null>(null);
  const [calib, setCalib] = useState<{ a: Pt; b: Pt } | null>(null);
  const [calibMm, setCalibMm] = useState("");
  const [saving, setSaving] = useState(false);
  const [natural, setNatural] = useState<Natural | null>(null);
  const drawing = useRef(false);

  const edited = isAdjusted(adjust) || marks.length > 0;
  const onCanvas = !!img && isPicture(img) && !img.sample && (panel !== null || edited);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);
  const clearEdits = useCallback(() => {
    setAdjust(NO_ADJUST);
    setMarks([]);
    setPast([]);
    setFuture([]);
    setDraft(null);
    setAngleArm(false);
    setMmPerPx(null);
    setCalib(null);
  }, []);
  // A new image opens fitted, at its own exposure, with nothing drawn on it.
  useEffect(() => {
    reset();
    clearEdits();
    setNatural(null);
  }, [index, img?.id, reset, clearEdits]);
  useEffect(() => setOtherId(null), [index]);

  // Leaving a picture with changes not saved asks first.
  const leave = useCallback((then: () => void) => {
    if (edited && !window.confirm(T.discard)) return;
    then();
  }, [edited, T.discard]);
  const go = useCallback((d: number) => leave(() => onIndex((index + d + images.length) % images.length)), [index, images.length, onIndex, leave]);
  const close = useCallback(() => leave(onClose), [leave, onClose]);

  useEffect(() => {
    /*
      Caught on the way down (capture), and kept: the chart beneath also
      listens for Escape and the arrows, and once this viewer has closed it
      would take the same Escape as "deselect the tooth" — closing the panel
      the doctor came from. A layer above this one (the send box) listens on
      window, earlier still.
    */
    const onKey = (e: KeyboardEvent) => {
      const handled = e.key === "Escape" || e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "+" || e.key === "=" || e.key === "-";
      if (!handled) return;
      // Typing in a box above the viewer (the WhatsApp message, a label) is typing, not zooming.
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" && el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.stopImmediatePropagation();
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(6, z * 1.25));
      else setZoom((z) => Math.max(1, z / 1.25));
    };
    document.addEventListener("keydown", onKey, true);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = "";
    };
  }, [go, close]);

  /* The picture's own pixels, once a tool needs them. Same origin, so the canvas may read them back. */
  useEffect(() => {
    if (!onCanvas || natural || !img) return;
    let stop = false;
    const el = new Image();
    el.decoding = "async";
    el.src = img.src;
    el.decode()
      .then(() => !stop && setNatural({ el, w: el.naturalWidth, h: el.naturalHeight }))
      .catch(() => !stop && setPanel(null));
    return () => {
      stop = true;
    };
  }, [onCanvas, natural, img]);

  /* The space the picture has, to fit it. */
  const area = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [FW, FH] = natural ? orientedSize(natural.w, natural.h, adjust.rot) : [1, 1];
  const unit = strokeUnit(FW, FH);
  const fit = natural && box.w && box.h ? Math.min(1, box.w / FW, box.h / FH) : 0;

  /* The preview: turned, then exposed — redrawn at most once a frame as a slider moves. */
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    if (!onCanvas || !natural || !cv) return;
    const raf = requestAnimationFrame(() => {
      const scale = Math.min(1, PREVIEW_MAX / Math.max(natural.w, natural.h));
      const [W, H] = orientedSize(Math.round(natural.w * scale), Math.round(natural.h * scale), adjust.rot);
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      drawOriented(ctx, natural.el, natural.w, natural.h, adjust, scale);
      if (isAdjusted({ ...adjust, rot: 0, flipH: false, flipV: false })) ctx.putImageData(processPixels(ctx.getImageData(0, 0, W, H), adjust), 0, 0);
    });
    return () => cancelAnimationFrame(raf);
    // `fit` too: the canvas is only there once the space is measured.
  }, [onCanvas, natural, adjust, fit > 0]);

  /* ── Marks ── */
  const svg = useRef<SVGSVGElement>(null);
  const toImg = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * FW, ((e.clientY - r.top) / r.height) * FH];
  };
  const commit = (m: Mark) => {
    setPast((p) => [...p, marks]);
    setMarks((ms) => [...ms, m]);
    setFuture([]);
  };
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [marks, ...f]);
    setMarks(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, marks]);
    setMarks(future[0]);
    setFuture((f) => f.slice(1));
  };
  const erase = (id: string) => {
    setPast((p) => [...p, marks]);
    setMarks((ms) => ms.filter((m) => m.id !== id));
    setFuture([]);
  };
  const clearMarks = () => {
    if (!marks.length) return;
    setPast((p) => [...p, marks]);
    setMarks([]);
    setFuture([]);
  };
  const newId = () => Math.random().toString(36).slice(2, 10);
  const drawsNow = panel === "draw" && tool !== "hand" && !!natural;

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawsNow || tool === "erase") return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = toImg(e);
    const w = unit * size;
    if (tool === "text") {
      if (text.trim()) commit({ id: newId(), t: "text", a: p, text: text.trim(), color: colour, w });
      return;
    }
    drawing.current = true;
    if (tool === "pen") setDraft({ id: newId(), t: "pen", pts: [p], color: colour, w });
    else if (tool === "angle") {
      if (angleArm && draft?.t === "angle") setDraft({ ...draft, c: p });
      else setDraft({ id: newId(), t: "angle", a: p, b: p, c: p, color: colour, w });
    } else if (tool === "calibrate") setDraft({ id: newId(), t: "ruler", a: p, b: p, color: "#ffffff", w });
    else setDraft({ id: newId(), t: tool, a: p, b: p, color: colour, w });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawsNow || !draft) return;
    // The second arm of an angle follows the mouse before the tap that ends it.
    if (!drawing.current && !(draft.t === "angle" && angleArm)) return;
    e.stopPropagation();
    const p = toImg(e);
    if (draft.t === "pen") {
      const last = draft.pts[draft.pts.length - 1];
      if (dist(last, p) > unit) setDraft({ ...draft, pts: [...draft.pts, p] });
    } else if (draft.t === "angle") setDraft(angleArm ? { ...draft, c: p } : { ...draft, b: p, c: p });
    else if (draft.t !== "text") setDraft({ ...draft, b: p });
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawsNow || !draft || !drawing.current) return;
    e.stopPropagation();
    drawing.current = false;
    const tiny = unit * 3;
    if (draft.t === "pen") {
      if (draft.pts.length > 1) commit(draft);
      setDraft(null);
    } else if (draft.t === "angle") {
      if (!angleArm) {
        if (dist(draft.a, draft.b) > tiny) setAngleArm(true);
        else setDraft(null);
      } else {
        if (dist(draft.b, draft.c) > tiny) commit(draft);
        setDraft(null);
        setAngleArm(false);
      }
    } else if (draft.t !== "text") {
      if (dist(draft.a, draft.b) > tiny) {
        if (tool === "calibrate") setCalib({ a: draft.a, b: draft.b });
        else commit(draft);
      }
      setDraft(null);
    }
  };

  /* ── Adjust ── */
  const turn = (d: 1 | -1) => {
    // Turning clockwise as seen is the other way round under one mirror.
    const step = adjust.flipH !== adjust.flipV ? -d : d;
    setAdjust((a) => ({ ...a, rot: (((a.rot + step * 90) % 360) + 360) % 360 as Adjust["rot"] }));
    const op = d === 1 ? "cw" : "ccw";
    setMarks((ms) => moveMarks(ms, op, FW, FH));
    setPast((p) => p.map((ms) => moveMarks(ms, op, FW, FH)));
    setFuture((f) => f.map((ms) => moveMarks(ms, op, FW, FH)));
  };
  const flip = (k: "flipH" | "flipV") => {
    setAdjust((a) => ({ ...a, [k]: !a[k] }));
    setMarks((ms) => moveMarks(ms, k, FW, FH));
    setPast((p) => p.map((ms) => moveMarks(ms, k, FW, FH)));
    setFuture((f) => f.map((ms) => moveMarks(ms, k, FW, FH)));
  };

  /* ── Save ── */
  const save = async (thenSend: boolean) => {
    if (!onSaveCopy || !natural || !img) return;
    setSaving(true);
    try {
      const cap = Math.min(1, SAVE_MAX / Math.max(natural.w, natural.h));
      const [W, H] = orientedSize(Math.round(natural.w * cap), Math.round(natural.h * cap), adjust.rot);
      const cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      drawOriented(ctx, natural.el, natural.w, natural.h, adjust, cap);
      if (isAdjusted({ ...adjust, rot: 0, flipH: false, flipV: false })) ctx.putImageData(processPixels(ctx.getImageData(0, 0, W, H), adjust), 0, 0);
      ctx.save();
      ctx.scale(cap, cap);
      drawMarks(ctx, marks, mmPerPx);
      ctx.restore();
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.92));
      if (!blob) throw new Error("blob");
      const base = img.name.replace(/\.[a-z0-9]{1,5}$/i, "") || "image";
      const copy = await onSaveCopy(img, new File([blob], `${base} (${T.editedSuffix}).jpg`, { type: "image/jpeg" }));
      if (copy) {
        clearEdits();
        setPanel(null);
        if (thenSend && onSend) onSend(copy);
      }
    } catch {
      // the parent says what went wrong
    } finally {
      setSaving(false);
    }
  };

  const look = useMemo(
    () => ({
      transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
      transition: drag.current ? "none" : "transform 120ms ease-out",
    }),
    [zoom, pan]
  );

  if (!img || typeof document === "undefined") return null;
  const pinned = pins[img.id] ?? [];
  const btn = "grid h-9 w-9 place-items-center rounded-ctl text-white/85 hover:bg-white/10 disabled:opacity-35";
  const pill = (on: boolean) =>
    `inline-flex h-9 shrink-0 items-center gap-1.5 rounded-ctl px-2.5 text-[12.5px] font-semibold ${on ? "bg-white text-black" : "text-white/85 hover:bg-white/10"}`;
  // What it can be compared with: pictures of the same teeth, or any picture if none share a tooth.
  const pictures = images.filter((x) => x.id !== img.id && isPicture(x));
  const sharing = pictures.filter((x) => (pins[x.id] ?? []).some((fdi) => pinned.includes(fdi)));
  const candidates = sharing.length ? sharing : pictures;
  const before = candidates.filter((x) => x.date <= img.date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const other = comparing ? (candidates.find((x) => x.id === otherId) ?? before ?? candidates[0] ?? null) : null;
  const views = T.views as Record<string, string>;
  const what = (img.view && views[img.view]) || ((t.patients.files.kinds as Record<string, string>)[img.kind] ?? img.kind);
  const canTools = isPicture(img) && !img.sample;

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
          <div className="text-[12px] text-white/60" data-viewer-what>
            {what} · {fmtDateOnly(img.date, locale)}
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
            <button type="button" className={btn} onClick={reset} aria-label={T.resetView}>
              <RotateCcw className="h-4 w-4" />
            </button>
            {canTools && !comparing && (
              <>
                <button type="button" onClick={() => setPanel((p) => (p === "adjust" ? null : "adjust"))} aria-pressed={panel === "adjust"} className={pill(panel === "adjust")} data-viewer-adjust>
                  <SlidersHorizontal className="h-4 w-4" />
                  {T.adjust}
                </button>
                <button type="button" onClick={() => setPanel((p) => (p === "draw" ? null : "draw"))} aria-pressed={panel === "draw"} className={pill(panel === "draw")} data-viewer-draw>
                  <Pencil className="h-4 w-4" />
                  {T.draw}
                </button>
              </>
            )}
          </div>
        )}
        {isPicture(img) && candidates.length > 0 && !edited && panel === null && (
          <button type="button" onClick={() => setComparing((v) => !v)} aria-pressed={comparing} className={pill(comparing)} data-compare>
            <Columns2 className="h-4 w-4" />
            {T.compare}
          </button>
        )}
        {/* Changes made: kept only by saving a copy — the original stays as it came. */}
        {edited && onSaveCopy && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={saving || !natural}
              onClick={() => void save(false)}
              className="inline-flex h-9 items-center gap-1.5 rounded-ctl bg-white px-3 text-[12.5px] font-semibold text-black hover:bg-white/90 disabled:opacity-60"
              data-viewer-save
            >
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {T.save}
            </button>
            {onSend && (
              <button
                type="button"
                disabled={saving || !natural}
                onClick={() => void save(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-ctl bg-st-confirmed px-3 text-[12.5px] font-semibold text-surface hover:brightness-110 disabled:opacity-60"
                data-viewer-save-send
              >
                <MessageCircle className="h-4 w-4" />
                {T.saveAndSend}
              </button>
            )}
          </div>
        )}
        {onSend && isPicture(img) && !img.sample && !edited && (
          <button
            type="button"
            onClick={() => onSend(img)}
            className="inline-flex h-9 items-center gap-1.5 rounded-ctl bg-st-confirmed px-3 text-[12.5px] font-semibold text-surface hover:brightness-110"
            data-send-patient
          >
            <MessageCircle className="h-4 w-4" />
            {T.sendToPatient}
          </button>
        )}
        <button type="button" className={btn} onClick={close} aria-label={T.close}>
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* The image: wheel or buttons to zoom, drag to move, double-tap to jump in and back. */}
      <div
        ref={area}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
        onWheel={(e) => setZoom((z) => Math.min(6, Math.max(1, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))}
        onDoubleClick={() => {
          if (drawsNow) return;
          if (zoom > 1) {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          } else setZoom(2.5);
        }}
        onPointerDown={(e) => {
          if (zoom <= 1 || drawsNow) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setPan({ x: d.px + (e.clientX - d.x) / zoom, y: d.py + (e.clientY - d.y) / zoom });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {isPicture(img) && other ? (
          <div className="absolute inset-0 grid grid-cols-1 gap-px bg-white/15 sm:grid-cols-2" data-compare-view>
            {[img, other].map((x, k) => (
              <div key={`${x.id}-${k}`} className="relative overflow-hidden bg-[rgb(6_8_12)]">
                {
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={x.src}
                    alt={x.name}
                    draggable={false}
                    className={`absolute inset-0 m-auto max-h-full max-w-full object-contain ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
                    style={look}
                  />
                }
                <span className="absolute start-2 top-2 rounded-full bg-black/65 px-2.5 py-0.5 text-[12px] font-semibold tabular-nums">
                  {fmtDateOnly(x.date, locale)}
                </span>
              </div>
            ))}
          </div>
        ) : onCanvas ? (
          natural && fit ? (
            <div
              className="absolute"
              style={{ left: (box.w - FW * fit) / 2, top: (box.h - FH * fit) / 2, width: FW * fit, height: FH * fit, ...look }}
              data-viewer-canvas
            >
              <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
              <svg
                ref={svg}
                viewBox={`0 0 ${FW} ${FH}`}
                preserveAspectRatio="none"
                className={`absolute inset-0 h-full w-full ${drawsNow ? (tool === "erase" ? "cursor-pointer" : "cursor-crosshair") : zoom > 1 ? "cursor-grab" : ""}`}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                data-viewer-marks={marks.length}
              >
                {marks.map((m) => (
                  <MarkShape key={m.id} m={m} mmPerPx={mmPerPx} erasable={drawsNow && tool === "erase"} onErase={() => erase(m.id)} />
                ))}
                {draft && <MarkShape m={draft} mmPerPx={mmPerPx} dashed={tool === "calibrate"} />}
                {calib && <MarkShape m={{ id: "calib", t: "ruler", a: calib.a, b: calib.b, color: "#ffffff", w: unit * 3 }} mmPerPx={null} dashed />}
              </svg>
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <LoaderCircle className="h-6 w-6 animate-spin text-white/70" />
            </div>
          )
        ) : isPicture(img) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img.src}
            alt={img.name}
            draggable={false}
            className={`absolute inset-0 m-auto max-h-full max-w-full object-contain ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
            style={look}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <a href={img.src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-ctl bg-white/10 px-4 py-2.5 text-[14px] font-semibold hover:bg-white/20">
              <ExternalLink className="h-4 w-4" />
              {T.openFile}
            </a>
          </div>
        )}
        {images.length > 1 && !other && !drawsNow && (
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

      {/* Adjust: the exposure, and turning the picture. */}
      {panel === "adjust" && (
        <div className="border-t border-white/10 px-3 py-2.5 sm:px-4" data-adjust-panel>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Slider icon={<Sun className="h-4 w-4" />} label={T.brightness} min={-100} max={100} value={adjust.bright} onChange={(v) => setAdjust((a) => ({ ...a, bright: v }))} hook="bright" />
            <Slider icon={<Contrast className="h-4 w-4" />} label={T.contrast} min={-100} max={100} value={adjust.contrast} onChange={(v) => setAdjust((a) => ({ ...a, contrast: v }))} hook="contrast" />
            <Slider icon={<span className="w-4 text-center text-[13px] font-bold">γ</span>} label={T.gamma} min={30} max={300} value={Math.round(adjust.gamma * 100)} shown={adjust.gamma.toFixed(2)} onChange={(v) => setAdjust((a) => ({ ...a, gamma: v / 100 }))} hook="gamma" />
            <Slider icon={<span className="w-4 text-center text-[13px] font-bold">◆</span>} label={T.sharpness} min={0} max={100} value={adjust.sharp} onChange={(v) => setAdjust((a) => ({ ...a, sharp: v }))} hook="sharp" />
          </div>
          <div className="mt-2 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
            <button type="button" onClick={() => setAdjust((a) => ({ ...a, invert: !a.invert }))} aria-pressed={adjust.invert} className={pill(adjust.invert)} data-adjust-invert>
              {T.invert}
            </button>
            <button type="button" onClick={() => setAdjust((a) => ({ ...a, equalize: !a.equalize }))} aria-pressed={adjust.equalize} className={pill(adjust.equalize)} data-adjust-equalize>
              {T.autoContrast}
            </button>
            <button type="button" onClick={() => setAdjust((a) => ({ ...a, emboss: !a.emboss }))} aria-pressed={adjust.emboss} className={pill(adjust.emboss)} data-adjust-emboss>
              {T.relief}
            </button>
            <span className="mx-1 w-px shrink-0 self-stretch bg-white/15" />
            {(["off", "heat", "rainbow"] as Colours[]).map((c) => (
              <button key={c} type="button" onClick={() => setAdjust((a) => ({ ...a, colours: c }))} aria-pressed={adjust.colours === c} className={pill(adjust.colours === c)} data-adjust-colours={c}>
                {c === "off" ? T.colourOff : c === "heat" ? T.colourHeat : T.colourRainbow}
              </button>
            ))}
            <span className="mx-1 w-px shrink-0 self-stretch bg-white/15" />
            <button type="button" onClick={() => turn(-1)} className={pill(false)} aria-label={T.rotateLeft} title={T.rotateLeft} disabled={!natural}>
              <RotateCcw className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => turn(1)} className={pill(false)} aria-label={T.rotateRight} title={T.rotateRight} disabled={!natural} data-adjust-rotate>
              <RotateCw className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => flip("flipH")} aria-pressed={adjust.flipH} className={pill(adjust.flipH)} aria-label={T.flipH} title={T.flipH} disabled={!natural}>
              <FlipHorizontal2 className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => flip("flipV")} aria-pressed={adjust.flipV} className={pill(adjust.flipV)} aria-label={T.flipV} title={T.flipV} disabled={!natural}>
              <FlipVertical2 className="h-4 w-4" />
            </button>
            <span className="mx-1 w-px shrink-0 self-stretch bg-white/15" />
            <button
              type="button"
              onClick={() => {
                // Back to the picture as it came; the marks move back with it.
                setMarks((ms) => restoreOrientation(ms, adjust, FW, FH));
                setPast([]);
                setFuture([]);
                setAdjust(NO_ADJUST);
              }}
              className={pill(false)}
              data-adjust-reset
            >
              {T.resetAdjust}
            </button>
          </div>
        </div>
      )}

      {/* Draw: marks, measurements, and their history. */}
      {panel === "draw" && (
        <div className="border-t border-white/10 px-3 py-2.5 sm:px-4" data-draw-panel>
          <div className="flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]" role="toolbar" aria-label={T.draw}>
            {(
              [
                ["hand", Hand, T.toolMove],
                ["pen", Pencil, T.toolBrush],
                ["arrow", MoveUpRight, T.toolArrow],
                ["line", Slash, T.toolLine],
                ["circle", Circle, T.toolCircle],
                ["text", Type, T.toolText],
                ["ruler", Ruler, T.toolRuler],
                ["angle", DraftingCompass, T.toolAngle],
                ["erase", Eraser, T.toolEraser],
              ] as [Tool, typeof Hand, string][]
            ).map(([k, Icon, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setTool(k);
                  setDraft(null);
                  setAngleArm(false);
                }}
                aria-pressed={tool === k}
                className={`flex h-12 min-w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-ctl px-1.5 text-[11px] font-semibold ${tool === k ? "bg-white text-black" : "text-white/80 hover:bg-white/10"}`}
                data-tool={k}
              >
                <Icon className="h-4.5 w-4.5" />
                {label}
              </button>
            ))}
            <span className="mx-1 w-px shrink-0 self-stretch bg-white/15" />
            <button type="button" onClick={undo} disabled={!past.length} className={`${btn} h-12 w-11`} aria-label={T.undo} title={T.undo} data-draw-undo>
              <Undo2 className="h-4.5 w-4.5" />
            </button>
            <button type="button" onClick={redo} disabled={!future.length} className={`${btn} h-12 w-11`} aria-label={T.redo} title={T.redo}>
              <Redo2 className="h-4.5 w-4.5" />
            </button>
            <button type="button" onClick={clearMarks} disabled={!marks.length} className={`${btn} h-12 w-11`} aria-label={T.clear} title={T.clear}>
              <Trash2 className="h-4.5 w-4.5" />
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-white/75">
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label={T.colour}>
              {MARK_COLOURS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={colour === c}
                  aria-label={c}
                  onClick={() => setColour(c)}
                  className={`h-7 w-7 rounded-full border-2 ${colour === c ? "border-white" : "border-transparent"}`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-1" role="radiogroup" aria-label={T.size}>
              {SIZES.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={size === s}
                  onClick={() => setSize(s)}
                  className={`grid h-8 w-8 place-items-center rounded-ctl ${size === s ? "bg-white/20" : "hover:bg-white/10"}`}
                  aria-label={[T.small, T.medium, T.large][i]}
                >
                  <span className="rounded-full bg-white" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
                </button>
              ))}
            </div>
            {tool === "text" && (
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={60}
                dir="auto"
                placeholder={T.textPlaceholder}
                className="h-9 w-56 rounded-ctl border border-white/20 bg-white/10 px-2.5 text-base text-white placeholder:text-white/45 md:text-sm"
                data-draw-text
              />
            )}
            {(tool === "ruler" || tool === "calibrate") && (
              <span className="flex flex-wrap items-center gap-2">
                <span className="tnum">{mmPerPx ? T.calibrated.replace("{mm}", mmPerPx.toFixed(3)) : T.notCalibrated}</span>
                <button type="button" onClick={() => setTool(tool === "calibrate" ? "ruler" : "calibrate")} aria-pressed={tool === "calibrate"} className={pill(tool === "calibrate")} data-draw-calibrate>
                  <Crosshair className="h-4 w-4" />
                  {T.calibrate}
                </button>
              </span>
            )}
            <span className="text-white/55">
              {tool === "calibrate"
                ? T.calibrateHint
                : tool === "angle"
                  ? angleArm
                    ? T.angleHint2
                    : T.angleHint
                  : tool === "text"
                    ? T.textHint
                    : tool === "erase"
                      ? T.eraseHint
                      : tool === "hand"
                        ? T.moveHint
                        : ""}
            </span>
          </div>
          {calib && (
            <form
              className="mt-2 flex flex-wrap items-center gap-2 text-[13px]"
              onSubmit={(e) => {
                e.preventDefault();
                const mm = Number(calibMm.replace(",", "."));
                if (!(mm > 0)) return;
                setMmPerPx(mm / dist(calib.a, calib.b));
                setCalib(null);
                setCalibMm("");
                setTool("ruler");
              }}
              data-calibrate-form
            >
              <span>{T.calibrateAsk}</span>
              <input
                autoFocus
                inputMode="decimal"
                value={calibMm}
                onChange={(e) => setCalibMm(e.target.value)}
                className="h-9 w-20 rounded-ctl border border-white/20 bg-white/10 px-2 text-center text-base text-white tnum md:text-sm"
                data-calibrate-mm
              />
              <span>mm</span>
              <button type="submit" className="h-9 rounded-ctl bg-white px-3 font-semibold text-black">
                {T.set}
              </button>
              <button type="button" onClick={() => setCalib(null)} className="h-9 rounded-ctl px-3 font-semibold text-white/80 hover:bg-white/10">
                {t.common.cancel}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Comparing: which other image stands beside this one. */}
      {comparing && (
        <div className="border-t border-white/10 px-3 py-2.5 sm:px-4" data-compare-pick>
          <div className="mb-1.5 text-[12px] font-semibold text-white/70">{T.compareWith}</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {candidates.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setOtherId(x.id)}
                aria-pressed={other?.id === x.id}
                className={`shrink-0 overflow-hidden rounded-md border-2 ${other?.id === x.id ? "border-white" : "border-transparent opacity-70 hover:opacity-100"}`}
                data-compare-option={x.id}
              >
                {
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={x.src} alt="" className="h-14 w-20 bg-black object-cover" />
                }
                <span className="block bg-black/70 px-1 text-[11px] tabular-nums">{fmtDateOnly(x.date, locale)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* What the image is, and the teeth it is of — a panoramic is not one tooth. */}
      <div className={`border-t border-white/10 px-3 py-2.5 sm:px-4 ${comparing || panel !== null || (!showTeeth && !onView) ? "hidden" : ""}`} data-pins>
        {onView && isPicture(img) && (
          <div className="mb-2.5" data-views>
            <div className="mb-1.5 text-[12px] font-semibold text-white/70">{T.whatItIs}</div>
            <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]" role="radiogroup" aria-label={T.whatItIs}>
              {FILE_VIEWS.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={img.view === v}
                  onClick={() => onView(img.id, img.view === v ? null : v)}
                  className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-semibold ${img.view === v ? "bg-white text-black" : "bg-white/8 text-white/75 hover:bg-white/15"}`}
                  data-view={v}
                >
                  {views[v]}
                </button>
              ))}
            </div>
          </div>
        )}
        {showTeeth && (
          <>
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
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

/** The marks moved back to the picture as it came, undoing every turn and flip. */
function restoreOrientation(marks: Mark[], a: Adjust, W: number, H: number): Mark[] {
  let ms = marks;
  let w = W;
  let h = H;
  // Undo the mirror first (it was applied last, as seen), then turn back.
  if (a.flipH) ms = moveMarks(ms, "flipH", w, h);
  if (a.flipV) ms = moveMarks(ms, "flipV", w, h);
  for (let r = a.rot; r > 0; r -= 90) {
    ms = moveMarks(ms, "ccw", w, h);
    [w, h] = [h, w];
  }
  return ms;
}

function Slider({
  icon,
  label,
  min,
  max,
  value,
  shown,
  onChange,
  hook,
}: {
  icon: React.ReactNode;
  label: string;
  min: number;
  max: number;
  value: number;
  shown?: string;
  onChange: (v: number) => void;
  hook: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-white/75" title={label}>
      {icon}
      <span className="w-20 shrink-0 truncate">{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-28 accent-white sm:w-32" data-adjust={hook} />
      <span className="w-9 text-end tabular-nums text-white/60">{shown ?? value}</span>
    </label>
  );
}

/** One mark, drawn as the saved file will draw it (lib/imaging/adjust drawMarks). */
function MarkShape({ m, mmPerPx, erasable, onErase, dashed }: { m: Mark; mmPerPx: number | null; erasable?: boolean; onErase?: () => void; dashed?: boolean }) {
  const common = {
    stroke: m.color,
    strokeWidth: m.w,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeDasharray: dashed ? `${m.w * 3} ${m.w * 2}` : undefined,
  };
  const label = (at: Pt, text: string, size: number) => (
    <text
      x={at[0]}
      y={at[1]}
      fontSize={size}
      fontWeight={600}
      fontFamily="system-ui, sans-serif"
      textAnchor="middle"
      dominantBaseline="middle"
      fill={m.color}
      stroke="rgba(0,0,0,0.85)"
      strokeWidth={size / 5}
      paintOrder="stroke"
    >
      {text}
    </text>
  );
  let body: React.ReactNode = null;
  if (m.t === "pen") body = <polyline points={m.pts.map((p) => p.join(",")).join(" ")} {...common} />;
  else if (m.t === "line" || m.t === "arrow" || m.t === "ruler") {
    const [l, r] = arrowHead(m.a, m.b, m.w * 4.5);
    const [a1, a2, b1, b2] = rulerTicks(m.a, m.b, m.w * 5);
    body = (
      <>
        <line x1={m.a[0]} y1={m.a[1]} x2={m.b[0]} y2={m.b[1]} {...common} />
        {m.t === "arrow" && <polyline points={`${l.join(",")} ${m.b.join(",")} ${r.join(",")}`} {...common} strokeDasharray={undefined} />}
        {m.t === "ruler" && (
          <>
            <line x1={a1[0]} y1={a1[1]} x2={a2[0]} y2={a2[1]} {...common} strokeDasharray={undefined} />
            <line x1={b1[0]} y1={b1[1]} x2={b2[0]} y2={b2[1]} {...common} strokeDasharray={undefined} />
          </>
        )}
      </>
    );
  } else if (m.t === "circle") body = <circle cx={m.a[0]} cy={m.a[1]} r={dist(m.a, m.b)} {...common} />;
  else if (m.t === "angle") {
    const arc = angleArc(m.a, m.b, m.c);
    const p1 = [m.b[0] + Math.cos(arc.from) * arc.r, m.b[1] + Math.sin(arc.from) * arc.r];
    const p2 = [m.b[0] + Math.cos(arc.to) * arc.r, m.b[1] + Math.sin(arc.to) * arc.r];
    body = (
      <>
        <polyline points={`${m.a.join(",")} ${m.b.join(",")} ${m.c.join(",")}`} {...common} />
        {dist(m.b, m.c) > 0 && <path d={`M ${p1.join(" ")} A ${arc.r} ${arc.r} 0 0 ${arc.sweep} ${p2.join(" ")}`} {...common} />}
      </>
    );
  } else if (m.t === "text") body = label(m.a, m.text, m.w * 7);
  const l = m.t === "angle" && dist(m.b, m.c) === 0 ? null : labelAt(m, mmPerPx);
  return (
    <g
      onPointerDown={
        erasable
          ? (e) => {
              e.stopPropagation();
              onErase?.();
            }
          : undefined
      }
      style={{ cursor: erasable ? "pointer" : undefined }}
      data-mark={m.t}
    >
      {/* A wide clear stroke: an eraser's tap does not have to land on a hairline. */}
      {erasable && m.t !== "text" && (
        <g stroke="transparent" strokeWidth={m.w * 6} fill="none" pointerEvents="stroke">
          {m.t === "pen" ? (
            <polyline points={m.pts.map((p) => p.join(",")).join(" ")} />
          ) : m.t === "circle" ? (
            <circle cx={m.a[0]} cy={m.a[1]} r={dist(m.a, m.b)} />
          ) : m.t === "angle" ? (
            <polyline points={`${m.a.join(",")} ${m.b.join(",")} ${m.c.join(",")}`} />
          ) : (
            <line x1={m.a[0]} y1={m.a[1]} x2={m.b[0]} y2={m.b[1]} />
          )}
        </g>
      )}
      {body}
      {l && label(l.at, l.text, m.w * 5.5)}
    </g>
  );
}
