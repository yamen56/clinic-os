"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2, Play, Pause } from "lucide-react";

/**
 * Records a short spoken note.
 *
 * `MediaRecorder` with no `mimeType` on purpose: every browser records
 * something it can also play, and naming a codec is how you get an exception on
 * the one browser that does not support it. What comes out is read back off the
 * Blob and sent as-is, so the server stores what was actually produced rather
 * than what we assumed.
 *
 * The microphone track is stopped explicitly when recording ends. Without it
 * the browser's recording indicator stays lit after the note is saved, which
 * reads — correctly — as "this page is still listening".
 *
 * While it records it looks the way people know from WhatsApp and Instagram
 * (Yamen, 2026-11-28: "a nice animation like whatsapp and instagram"): a red
 * dot that breathes, the time running, and a waveform that moves with the
 * voice — read off the microphone itself, so a silent mic shows a flat line
 * and the person knows before saving that nothing is being heard. A bin throws
 * the recording away; stop keeps it.
 */
const BARS = 26;
const BAR_EVERY_MS = 75;

export function VoiceRecorder({
  onReady,
  disabled,
  immediate,
  onRecording,
  labels,
}: {
  /** Called with the finished recording, or null when it is discarded. */
  onReady: (rec: { blob: Blob; seconds: number } | null) => void;
  disabled?: boolean;
  /**
   * Stop means save.
   *
   * Without this the recorder holds the clip in a preview — play it back,
   * discard it, then press Save — which is two presses for something a doctor
   * does between patients with a hand already reaching for the door. The caller
   * takes the blob straight from `onReady` and files it; the button goes back to
   * idle rather than into a preview it would never be read.
   */
  immediate?: boolean;
  /** Told when recording starts and ends — a composer hides its text box meanwhile, as WhatsApp does. */
  onRecording?: (on: boolean) => void;
  labels: {
    record: string;
    stop: string;
    discard: string;
    denied: string;
    unsupported: string;
    noMic: string;
    insecure: string;
    retry: string;
  };
}) {
  const [state, setState] = useState<
    "idle" | "recording" | "ready" | "denied" | "nomic" | "insecure" | "unsupported"
  >("idle");
  const [seconds, setSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  /** The newest levels, one per bar, 0–1; and every level of the clip, for its waveform afterwards. */
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [peaks, setPeaks] = useState<number[]>([]);
  const [played, setPlayed] = useState(0);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const listen = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const all = useRef<number[]>([]);
  const cancelled = useRef(false);
  const told = useRef(onRecording);
  told.current = onRecording;

  useEffect(() => {
    if (typeof window !== "undefined" && !("MediaRecorder" in window)) setState("unsupported");
  }, []);

  useEffect(() => told.current?.(state === "recording"), [state]);

  const stopListening = () => {
    if (!listen.current) return;
    cancelAnimationFrame(listen.current.raf);
    void listen.current.ctx.close().catch(() => {});
    listen.current = null;
  };

  // Release the microphone and the object URL whichever way this unmounts —
  // navigating away mid-recording must not leave the mic open.
  useEffect(() => {
    return () => {
      if (tick.current) clearInterval(tick.current);
      cancelled.current = true;
      recorder.current?.state === "recording" && recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      stopListening();
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  /*
    The waveform: how loud the microphone is, sampled a dozen times a second,
    each new reading pushing the oldest bar off the end. No analyser (an old
    browser, a blocked AudioContext) only means a quiet line; the recording
    itself does not depend on it.
  */
  const startListening = (s: MediaStream) => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      ctx.createMediaStreamSource(s).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let last = 0;
      const loop = (now: number) => {
        if (!listen.current) return;
        listen.current.raf = requestAnimationFrame(loop);
        if (now - last < BAR_EVERY_MS) return;
        last = now;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const x = (buf[i] - 128) / 128;
          sum += x * x;
        }
        // Speech sits around 0.02–0.2 RMS; lifted and capped so a normal voice fills the bar.
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        all.current.push(level);
        setLevels((prev) => [...prev.slice(1), level]);
      };
      listen.current = { ctx, raf: requestAnimationFrame(loop) };
    } catch {
      listen.current = null;
    }
  };

  const start = async () => {
    try {
      /*
        `mediaDevices` is undefined outside a secure context, and "outside a
        secure context" includes the case that actually happens: a clinic opening
        the app on the office network by IP rather than by hostname. Reading it
        blind throws a TypeError that lands in the same catch as a refusal, and
        the person is told they denied a permission they were never asked for.
      */
      if (!navigator.mediaDevices?.getUserMedia) {
        setState("insecure");
        return;
      }
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const mr = new MediaRecorder(s);
      chunks.current = [];
      cancelled.current = false;
      all.current = [];
      setLevels(Array(BARS).fill(0));
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      mr.onstop = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        stream.current = null;
        stopListening();
        // Thrown away with the bin: nothing is handed on, and nothing is kept.
        if (cancelled.current) {
          chunks.current = [];
          setSeconds(0);
          elapsed.current = 0;
          setState("idle");
          return;
        }
        const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
        // Read the count off the ref rather than the closure: `seconds` here
        // would be whatever it was when recording started, which is zero.
        const rec = { blob, seconds: elapsed.current };

        if (immediate) {
          // Straight back to idle. There is no preview to keep an object URL
          // alive for, and the caller is filing this clip as we return.
          setSeconds(0);
          elapsed.current = 0;
          setState("idle");
          onReady(rec);
          return;
        }

        setPeaks(squeeze(all.current, 32));
        setPlayed(0);
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setState("ready");
        onReady(rec);
      };
      mr.start();
      recorder.current = mr;
      elapsed.current = 0;
      setSeconds(0);
      setState("recording");
      startListening(s);
      tick.current = setInterval(() => {
        elapsed.current += 1;
        setSeconds(elapsed.current);
      }, 1000);
    } catch (e) {
      /*
        Which refusal this was decides what the person can do about it, so it is
        worth telling them apart. NotAllowedError is the browser saying no —
        either the person clicked Block, or a Permissions-Policy header did it
        for them without ever showing a prompt (which is how this shipped:
        `microphone=()` in next.config.ts denied our own origin). NotFoundError
        is a machine with no microphone, which no amount of clicking fixes.
      */
      const name = (e as DOMException)?.name;
      setState(name === "NotFoundError" || name === "OverconstrainedError" ? "nomic" : "denied");
    }
  };

  const elapsed = useRef(0);

  const stop = () => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    recorder.current?.state === "recording" && recorder.current.stop();
  };

  /** The bin while recording: stop, and keep nothing. */
  const cancel = () => {
    cancelled.current = true;
    stop();
  };

  const discard = () => {
    if (url) URL.revokeObjectURL(url);
    setUrl(null);
    setSeconds(0);
    elapsed.current = 0;
    setState("idle");
    setPlaying(false);
    onReady(null);
  };

  const mmss = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

  if (state === "unsupported") {
    return <span className="text-[0.75rem] text-ink-400">{labels.unsupported}</span>;
  }
  /*
    A refusal is a state to recover from, not a dead end. This used to render a
    line of red text and nothing else — so somebody who denied the prompt by
    accident, or who was denied by a header they could not see, had no way back
    short of reloading the page. The message says what happened and the button
    lets them try again once they have fixed it in the browser.
  */
  if (state === "denied" || state === "nomic" || state === "insecure") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.75rem] text-danger">
          {state === "nomic" ? labels.noMic : state === "insecure" ? labels.insecure : labels.denied}
        </span>
        {state !== "insecure" && (
          <button
            type="button"
            onClick={() => {
              setState("idle");
              void start();
            }}
            className="text-[0.75rem] font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
          >
            {labels.retry}
          </button>
        )}
      </div>
    );
  }

  /* Recorded and kept for a listen first: the clip's own waveform, filling in as it plays. */
  if (state === "ready" && url) {
    return (
      <div className="inline-flex h-11 items-center gap-2 rounded-full bg-surface pe-1 ps-1 shadow-card ring-1 ring-line animate-fade-in" data-voice-ready>
        <audio
          ref={audio}
          src={url}
          onEnded={() => {
            setPlaying(false);
            setPlayed(0);
          }}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            setPlayed(a.duration && Number.isFinite(a.duration) ? a.currentTime / a.duration : 0);
          }}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => (playing ? audio.current?.pause() : audio.current?.play())}
          aria-label={playing ? "Pause" : "Play"}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 text-on-brand transition-transform active:scale-95"
        >
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current rtl:rotate-180" />}
        </button>
        <Wave levels={peaks.length ? peaks : Array(32).fill(0.15)} filled={played} tone="brand" />
        <span className="w-10 shrink-0 text-[0.75rem] font-medium text-ink-500 tnum">{mmss(seconds)}</span>
        <button
          type="button"
          onClick={discard}
          aria-label={labels.discard}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-400 transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div
        className="inline-flex h-11 w-full min-w-0 max-w-full origin-right items-center gap-2 rounded-full bg-surface pe-1 ps-1 shadow-card ring-1 ring-danger/25 animate-rec-in rtl:origin-left sm:w-auto"
        role="status"
        aria-live="polite"
        data-voice-recording
      >
        <button
          type="button"
          onClick={cancel}
          aria-label={labels.discard}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-500 transition-colors hover:bg-danger-soft hover:text-danger"
          data-voice-cancel
        >
          <Trash2 className="h-4 w-4" />
        </button>
        {/* The dot that breathes, with a ring going out from it — what says "recording" at a glance. */}
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-danger opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger motion-safe:animate-rec-dot" />
        </span>
        <span className="w-10 shrink-0 text-[0.8125rem] font-semibold text-ink-900 tnum">{mmss(seconds)}</span>
        <Wave levels={levels} tone="live" />
        <button
          type="button"
          onClick={stop}
          aria-label={labels.stop}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger text-white shadow-sm transition-transform active:scale-95"
          data-voice-stop
        >
          <Square className="h-3.5 w-3.5 fill-current" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 text-[0.8125rem] font-medium text-ink-700 transition-colors hover:border-brand-500 hover:text-brand-700 active:scale-[0.98] disabled:opacity-40 sm:h-9"
      data-voice-record
    >
      <Mic className="h-4 w-4" />
      {labels.record}
    </button>
  );
}

/**
 * Bars for a level each, centred on a line, like WhatsApp's. `live` is the
 * microphone as it is now — red, each bar easing to its height; otherwise the
 * clip's own shape, navy up to how much has played.
 */
function Wave({ levels, tone, filled = 0 }: { levels: number[]; tone: "live" | "brand"; filled?: number }) {
  return (
    <span className="flex h-7 min-w-0 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden data-voice-wave>
      {levels.map((l, i) => (
        <span
          key={i}
          className={`w-[3px] shrink-0 rounded-full transition-[height,background-color] duration-100 ease-out ${
            tone === "live" ? "bg-danger/75" : i / levels.length < filled ? "bg-brand-600" : "bg-ink-300"
          }`}
          style={{ height: `${Math.max(3, Math.round(l * 26))}px` }}
        />
      ))}
    </span>
  );
}

/** A long run of levels as `n` bars: each bar the loudest of its stretch, so short peaks still show. */
function squeeze(xs: number[], n: number): number[] {
  if (!xs.length) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * xs.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * xs.length) / n));
    out.push(Math.max(...xs.slice(from, to)));
  }
  return out;
}
