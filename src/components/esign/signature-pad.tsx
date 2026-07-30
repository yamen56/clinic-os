"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useI18nSafe } from "@/lib/i18n/client";
import { dictFor, type Locale } from "@/lib/i18n/client-dict";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eraser, Undo2, PenLine, Type } from "lucide-react";

/**
 * Signature capture.
 *
 * The stroke has to look like ink, not like a polyline. Two things get it there:
 * every segment is drawn as a quadratic curve through the midpoints of three
 * consecutive samples, so corners round off the way a pen does; and the width of
 * each segment is derived from how fast the point was moving, so a fast flick
 * thins and a slow deliberate loop thickens. Both are cheap, and without them a
 * finger-drawn name reads as a child's scribble on any device that samples
 * pointer events coarsely.
 *
 * Pointer events, not touch or mouse events: one code path serves finger, stylus
 * (including pressure, where the device reports it) and mouse.
 */

export type SignatureValue = {
  /** PNG data URL, trimmed to the ink. */
  png: string;
  /** SVG document, same geometry, for re-rendering at any size. */
  svg: string;
  /** Set when the signer typed rather than drew. */
  typedName: string | null;
  /** Raw strokes, so an abandoned session can resume mid-signature. */
  strokes: Stroke[];
};

export type Point = { x: number; y: number; t: number; p: number };
export type Stroke = Point[];

export type SignaturePadHandle = {
  /** Current value, or null when nothing has been drawn or typed. */
  value: () => SignatureValue | null;
  /**
   * The raw strokes only. Cheap, unlike `value()`, which re-renders the canvas
   * and serialises a PNG — so this is what the resume ping reads.
   */
  strokes: () => Stroke[];
  clear: () => void;
  isEmpty: () => boolean;
};

const MIN_WIDTH = 1.1;
const MAX_WIDTH = 3.4;
/** Velocity (px/ms) at which the stroke reaches MIN_WIDTH. */
const VELOCITY_CEILING = 1.6;

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t: b.t, p: b.p };
}

function widthFor(a: Point, b: Point): number {
  const dt = Math.max(1, b.t - a.t);
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const velocity = Math.min(VELOCITY_CEILING, dist / dt);
  // Pressure, where the stylus reports it, nudges the same range rather than
  // replacing it — a mouse always reports 0.5 and must not draw hairlines.
  const pressureBoost = b.p > 0 ? (b.p - 0.5) * 1.2 : 0;
  const base = MAX_WIDTH - (velocity / VELOCITY_CEILING) * (MAX_WIDTH - MIN_WIDTH);
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH + 1, base + pressureBoost));
}

export function SignaturePad({
  ref,
  /**
   * Fires when the ink changes: once when the first mark appears, and again at
   * the end of every stroke.
   *
   * That second case is what makes resuming work. It used to fire only on the
   * first pixel, so an abandoned signature was persisted as a single point and
   * came back as an empty pad — the feature looked implemented and was not.
   */
  onChange,
  initialStrokes,
  initialTypedName,
  suggestedName,
  allowTyped = true,
  /**
   * The language of the pad's own chrome — Clear, Undo, "type my name instead".
   *
   * Passed explicitly on the signing screens, where the language belongs to the
   * *document* rather than to the visitor. Reading it from the workspace provider
   * put Arabic buttons on an English consent form for anyone whose browser had no
   * language cookie, which is every patient opening a link for the first time.
   * Omitted inside the workspace, where the provider is the right answer.
   */
  locale,
  /*
    A third of the viewport, on every device.

    The `sm:` cap this used to carry pinned the pad to 224px on anything wider
    than a phone, which is most of a tablet's screen wasted and a cramped box to
    sign your name in — on the exact device the clinic hands to patients. `dvh`
    rather than `vh` so a mobile browser's collapsing toolbar does not shrink it
    mid-signature.
  */
  heightClass = "h-[34dvh] min-h-56",
}: {
  ref?: React.Ref<SignaturePadHandle>;
  onChange?: (hasInk: boolean) => void;
  initialStrokes?: Stroke[];
  initialTypedName?: string | null;
  /** Pre-fills the typed field, so the common case is one tap. */
  suggestedName?: string;
  allowTyped?: boolean;
  locale?: Locale;
  heightClass?: string;
}) {
  const provider = useI18nSafe();
  const t = locale ? dictFor(locale) : provider.t;
  const uiLocale = locale ?? provider.locale;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef<Stroke[]>(initialStrokes?.length ? initialStrokes : []);
  const currentRef = useRef<Stroke | null>(null);
  const [mode, setMode] = useState<"draw" | "type">(initialTypedName ? "type" : "draw");
  const [typed, setTyped] = useState(initialTypedName ?? "");
  const [hasInk, setHasInk] = useState((initialStrokes?.length ?? 0) > 0);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // The face follows what was actually typed, falling back to the document's
  // language for the empty-state preview.
  const typedScript = /[؀-ۿݐ-ݿ]/.test(typed) || (!typed && uiLocale === "ar") ? "ar" : "latin";

  /* --------------------------------------------------------------- drawing */

  const drawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#16181c";

    for (const stroke of strokesRef.current) {
      if (stroke.length === 1) {
        // A single tap is a dot, not nothing — people do sign with dots.
        const p = stroke[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, MAX_WIDTH / 2, 0, Math.PI * 2);
        ctx.fillStyle = "#16181c";
        ctx.fill();
        continue;
      }
      for (let i = 2; i < stroke.length; i++) {
        const a = stroke[i - 2];
        const b = stroke[i - 1];
        const c = stroke[i];
        const from = midpoint(a, b);
        const to = midpoint(b, c);
        ctx.beginPath();
        ctx.lineWidth = widthFor(b, c);
        ctx.moveTo(from.x, from.y);
        // b is the control point: the curve passes through the midpoints and
        // bends toward the sample between them.
        ctx.quadraticCurveTo(b.x, b.y, to.x, to.y);
        ctx.stroke();
      }
    }
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      setSize({ w: rect.width, h: rect.height });
      drawAll();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [drawAll]);

  const pointFrom = (e: PointerEvent | React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      t: performance.now(),
      p: (e as PointerEvent).pressure ?? 0,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "draw") return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    currentRef.current = [pointFrom(e)];
    strokesRef.current = [...strokesRef.current, currentRef.current];
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentRef.current) return;
    e.preventDefault();
    /*
      Coalesced events matter here. A 120Hz screen delivers several samples per
      frame, and taking only the latest is exactly what turns a smooth curve into
      a chain of straight cuts on fast strokes.
    */
    const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const events = native.getCoalescedEvents?.() ?? [];
    const points = events.length ? events.map(pointFrom) : [pointFrom(e)];
    for (const p of points) currentRef.current.push(p);
    drawAll();
    if (!hasInk) {
      setHasInk(true);
      onChange?.(true);
    }
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentRef.current) return;
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    // Drop a stroke that is only a stray tap with no points; keeping it would
    // count as ink and enable the submit button on an empty-looking pad.
    if (currentRef.current.length === 0) {
      strokesRef.current = strokesRef.current.filter((s) => s !== currentRef.current);
    }
    currentRef.current = null;
    drawAll();
    const has = strokesRef.current.length > 0;
    setHasInk(has);
    // The stroke is finished, so this is the moment worth persisting.
    onChange?.(has);
  };

  const clear = () => {
    strokesRef.current = [];
    currentRef.current = null;
    setTyped("");
    setHasInk(false);
    onChange?.(false);
    drawAll();
  };

  const undo = () => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    const empty = strokesRef.current.length === 0;
    setHasInk(!empty);
    onChange?.(!empty);
    drawAll();
  };

  /* ---------------------------------------------------------------- output */

  const buildDrawn = useCallback((): SignatureValue | null => {
    const strokes = strokesRef.current.filter((s) => s.length > 0);
    if (!strokes.length) return null;

    // Trim to the ink so the signature sits on its own baseline in the PDF
    // rather than floating inside a mostly-empty rectangle.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes)
      for (const p of s) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    const pad = MAX_WIDTH * 2 + 4;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);

    const out = document.createElement("canvas");
    const scale = 3; // print-resolution, still a small file for line art
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const ctx = out.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.translate(-minX, -minY);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#16181c";
    ctx.fillStyle = "#16181c";

    const paths: string[] = [];
    for (const stroke of strokes) {
      if (stroke.length === 1) {
        const p = stroke[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, MAX_WIDTH / 2, 0, Math.PI * 2);
        ctx.fill();
        paths.push(
          `<circle cx="${(p.x - minX).toFixed(2)}" cy="${(p.y - minY).toFixed(2)}" r="${(MAX_WIDTH / 2).toFixed(2)}" fill="#16181c"/>`
        );
        continue;
      }
      let d = "";
      for (let i = 2; i < stroke.length; i++) {
        const a = stroke[i - 2];
        const b = stroke[i - 1];
        const c = stroke[i];
        const from = midpoint(a, b);
        const to = midpoint(b, c);
        const width = widthFor(b, c);
        ctx.beginPath();
        ctx.lineWidth = width;
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(b.x, b.y, to.x, to.y);
        ctx.stroke();
        d += `${i === 2 ? `M${(from.x - minX).toFixed(2)},${(from.y - minY).toFixed(2)}` : ""}Q${(b.x - minX).toFixed(2)},${(b.y - minY).toFixed(2)} ${(to.x - minX).toFixed(2)},${(to.y - minY).toFixed(2)}`;
      }
      if (d) {
        paths.push(
          `<path d="${d}" fill="none" stroke="#16181c" stroke-width="${MAX_WIDTH.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`
        );
      }
    }

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}">` +
      paths.join("") +
      `</svg>`;

    return { png: out.toDataURL("image/png"), svg, typedName: null, strokes };
  }, []);

  const buildTyped = useCallback((): SignatureValue | null => {
    const name = typed.trim();
    if (!name) return null;
    const isAr = /[؀-ۿݐ-ݿ]/.test(name);
    const family = isAr ? '"Aref Ruqaa", serif' : '"Dancing Script", cursive';
    const fontSize = 96;

    const out = document.createElement("canvas");
    const ctx = out.getContext("2d")!;
    ctx.font = `700 ${fontSize}px ${family}`;
    const metrics = ctx.measureText(name);
    const w = Math.ceil(metrics.width + fontSize * 0.4);
    const h = Math.ceil(fontSize * (isAr ? 2.0 : 1.7));
    out.width = w;
    out.height = h;
    const c2 = out.getContext("2d")!;
    // The font must be reapplied: resizing the canvas resets its state.
    c2.font = `700 ${fontSize}px ${family}`;
    c2.fillStyle = "#16181c";
    c2.textBaseline = "middle";
    c2.textAlign = "center";
    // Canvas shapes and orders Arabic correctly; the browser's own text engine
    // is doing the work, which is the same reason the PDF is printed by Chromium.
    c2.direction = isAr ? "rtl" : "ltr";
    c2.fillText(name, w / 2, h / 2);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<text x="${w / 2}" y="${h / 2}" font-family=${JSON.stringify(family)} font-size="${fontSize}" font-weight="700" fill="#16181c" text-anchor="middle" dominant-baseline="middle"${isAr ? ' direction="rtl"' : ""}>${name.replace(/[<>&]/g, "")}</text>` +
      `</svg>`;

    return { png: out.toDataURL("image/png"), svg, typedName: name, strokes: [] };
  }, [typed]);

  useImperativeHandle(
    ref,
    () => ({
      value: () => (mode === "type" ? buildTyped() : buildDrawn()),
      strokes: () => strokesRef.current,
      clear,
      isEmpty: () => (mode === "type" ? !typed.trim() : strokesRef.current.length === 0),
    }),
    // `clear` is stable enough for this handle; the deps that change the output
    // are the mode and the two builders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, typed, buildTyped, buildDrawn]
  );

  /* ------------------------------------------------------------------- view */

  return (
    <div className="grid gap-3">
      {mode === "draw" ? (
        <div>
          <div
            ref={wrapRef}
            className={`relative w-full overflow-hidden rounded-card border-2 border-dashed border-line-strong ${heightClass}`}
          >
            <canvas
              ref={canvasRef}
              className="sig-canvas absolute inset-0 h-full w-full"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={endStroke}
              aria-label={t.sign.signTitle}
            />
            <span className="sig-baseline" />
            {!hasInk && size.w > 0 && (
              <span className="pointer-events-none absolute inset-x-0 bottom-[14%] text-center text-[13px] text-ink-400">
                {t.sign.drawHint}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={undo} disabled={!hasInk}>
                <Undo2 className="h-4 w-4" />
                {t.sign.undo}
              </Button>
              <Button variant="outline" size="sm" onClick={clear} disabled={!hasInk}>
                <Eraser className="h-4 w-4" />
                {t.sign.clear}
              </Button>
            </div>
            {allowTyped && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode("type");
                  if (!typed && suggestedName) setTyped(suggestedName);
                  onChange?.(!!(typed || suggestedName));
                }}
              >
                <Type className="h-4 w-4" />
                {t.sign.typeInstead}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div className={`grid place-items-center rounded-card border-2 border-dashed border-line-strong px-4 ${heightClass}`}>
            {typed.trim() ? (
              <span className="sig-typed break-all text-center" data-script={typedScript}>
                {typed}
              </span>
            ) : (
              <span className="text-[13px] text-ink-400">{t.sign.typedPreview}</span>
            )}
          </div>
          <div className="mt-2 grid gap-2">
            <Input
              value={typed}
              autoFocus
              maxLength={80}
              placeholder={t.sign.yourName}
              onChange={(e) => {
                setTyped(e.target.value);
                setHasInk(!!e.target.value.trim());
                onChange?.(!!e.target.value.trim());
              }}
              aria-label={t.sign.yourName}
            />
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() => {
                setMode("draw");
                setHasInk(strokesRef.current.length > 0);
                onChange?.(strokesRef.current.length > 0);
              }}
            >
              <PenLine className="h-4 w-4" />
              {t.sign.drawInstead}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
