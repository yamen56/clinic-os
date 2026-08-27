"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";

/**
 * A recorded note, played the way a voice message is played.
 *
 * Not `<audio controls>`. The browser's own player is a different shape, size
 * and language on every platform, it carries a download button we do not want
 * on a clinical record, and at 300px wide it dominates a note whose text is the
 * point. This is a play button, a line you can scrub, and a clock.
 *
 * `seconds` comes from the database rather than from the file. A WebM produced
 * by MediaRecorder reports its duration as `Infinity` in Chrome until it has
 * been played to the end — a well-known consequence of writing a stream with no
 * length in the header — so trusting `audio.duration` would show "Infinity:NaN"
 * on exactly the recordings this app makes. The stored figure was measured
 * while recording and is always right.
 */
export function VoiceNote({
  src,
  seconds,
  label,
}: {
  src: string;
  seconds: number | null;
  label: string;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  /* What the file itself claims, once it is loaded and only if it is credible. */
  const [measured, setMeasured] = useState<number | null>(null);

  const total = seconds && seconds > 0 ? seconds : (measured ?? 0);

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const onTime = () => setAt(el.currentTime);
    const onEnd = () => {
      setPlaying(false);
      setAt(0);
    };
    const onMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) setMeasured(el.duration);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnd);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
    };
  }, []);

  const mmss = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(Math.floor(n % 60)).padStart(2, "0")}`;

  const pct = total > 0 ? Math.min(100, (at / total) * 100) : 0;

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  /** Scrub. Only where the file has a real length — see the note above. */
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audio.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    // The bar is laid out by the document's direction, so in RTL the left edge
    // is the end. Measuring from the inline start keeps the scrub honest.
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const raw = (e.clientX - box.left) / box.width;
    const ratio = Math.min(1, Math.max(0, rtl ? 1 - raw : raw));
    el.currentTime = ratio * el.duration;
    setAt(el.currentTime);
  };

  return (
    <div className="mb-2 flex max-w-md items-center gap-3 rounded-full bg-sunken px-3 py-2">
      <audio ref={audio} src={src} preload="none" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700"
      >
        {playing ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          /* Nudged one pixel: a triangle centred by its bounding box reads as
             sitting left of centre. */
          <Play className="h-4 w-4 translate-x-[1px] fill-current rtl:-translate-x-[1px]" />
        )}
      </button>
      <div
        onClick={seek}
        role="presentation"
        className="h-1.5 min-w-0 flex-1 cursor-pointer rounded-full bg-ink-900/10"
      >
        <div
          className="h-full rounded-full bg-brand-600 transition-[width] duration-100 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-[12px] font-medium tnum text-ink-500">
        {mmss(playing || at > 0 ? at : total)}
      </span>
    </div>
  );
}
