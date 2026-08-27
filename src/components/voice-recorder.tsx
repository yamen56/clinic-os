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
 */
export function VoiceRecorder({
  onReady,
  disabled,
  labels,
}: {
  /** Called with the finished recording, or null when it is discarded. */
  onReady: (rec: { blob: Blob; seconds: number } | null) => void;
  disabled?: boolean;
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

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && !("MediaRecorder" in window)) setState("unsupported");
  }, []);

  // Release the microphone and the object URL whichever way this unmounts —
  // navigating away mid-recording must not leave the mic open.
  useEffect(() => {
    return () => {
      if (tick.current) clearInterval(tick.current);
      recorder.current?.state === "recording" && recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

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
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
        stream.current?.getTracks().forEach((t) => t.stop());
        stream.current = null;
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setState("ready");
        // Read the count off the ref rather than the closure: `seconds` here
        // would be whatever it was when recording started, which is zero.
        onReady({ blob, seconds: elapsed.current });
      };
      mr.start();
      recorder.current = mr;
      elapsed.current = 0;
      setSeconds(0);
      setState("recording");
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
    return <span className="text-[12px] text-ink-400">{labels.unsupported}</span>;
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
        <span className="text-[12px] text-danger">
          {state === "nomic" ? labels.noMic : state === "insecure" ? labels.insecure : labels.denied}
        </span>
        {state !== "insecure" && (
          <button
            type="button"
            onClick={() => {
              setState("idle");
              void start();
            }}
            className="text-[12px] font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
          >
            {labels.retry}
          </button>
        )}
      </div>
    );
  }

  if (state === "ready" && url) {
    return (
      <div className="flex items-center gap-2">
        <audio
          ref={audio}
          src={url}
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => (playing ? audio.current?.pause() : audio.current?.play())}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-brand-50 px-3 text-[13px] font-medium text-brand-700"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span className="tnum">{mmss(seconds)}</span>
        </button>
        <button
          type="button"
          onClick={discard}
          aria-label={labels.discard}
          className="text-ink-400 transition-colors hover:text-danger"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <button
        type="button"
        onClick={stop}
        className="inline-flex h-8 items-center gap-2 rounded-full bg-danger-soft px-3 text-[13px] font-medium text-danger"
      >
        <Square className="h-3.5 w-3.5 fill-current" />
        {/* The dot is what makes "recording" read at a glance; the clock is what
            makes it read precisely. */}
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />
        <span className="tnum">{mmss(seconds)}</span>
        <span className="sr-only">{labels.stop}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-500 hover:text-brand-700 disabled:opacity-40"
    >
      <Mic className="h-3.5 w-3.5" />
      {labels.record}
    </button>
  );
}
