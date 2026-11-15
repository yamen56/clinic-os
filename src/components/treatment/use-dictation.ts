"use client";

/*
  Talking instead of typing: the browser's own speech recognition, as a hook.

  Yamen, 2026-11-15: "a talk mode where the doctor can make this process
  faster". A doctor between patients has one hand and no keyboard; saying
  "sore throat for three days" is quicker than thumbing it.

  This is the recognition every phone already has (Chrome on Android and
  desktop, Safari on iPhone), so there is nothing to install and nothing the
  clinic pays for. It is not everywhere — Firefox has none — so `supported`
  says whether to offer it at all. The words are worked out by the browser's
  own service, not by Clinicti: nothing is sent to our servers until the text
  lands in a field and is saved like typed text.

  It listens until told to stop: a browser ends a session after a silence,
  and a doctor examining a patient is silent a lot, so it is started again
  for as long as the switch is on.
*/

import { useCallback, useEffect, useRef, useState } from "react";

type ResultEvent = { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useDictation(opts: {
  /** A BCP 47 tag: "ar-JO", "en-US". */
  lang: string;
  /** A finished phrase, as the doctor paused. */
  onPhrase: (text: string) => void;
  /** The microphone was refused, or the recognition failed for good. */
  onError?: (reason: "denied" | "failed") => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  /** What is being heard right now, before the phrase is finished. */
  const [hearing, setHearing] = useState("");
  const rec = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const cfg = useRef(opts);
  cfg.current = opts;

  // Known only in the browser: said after mount, so the server's page and the first paint agree.
  useEffect(() => setSupported(!!recognitionCtor()), []);

  const stop = useCallback(() => {
    wanted.current = false;
    setListening(false);
    setHearing("");
    try {
      rec.current?.stop();
    } catch {}
  }, []);

  const begin = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = cfg.current.lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const said = res[0]?.transcript ?? "";
        if (res.isFinal) {
          if (said.trim()) cfg.current.onPhrase(said.trim());
        } else interim += said;
      }
      setHearing(interim.trim());
    };
    r.onerror = (e) => {
      // Silence is not a failure: the session ends and is started again below.
      if (e.error === "no-speech" || e.error === "aborted") return;
      wanted.current = false;
      setListening(false);
      setHearing("");
      cfg.current.onError?.(e.error === "not-allowed" || e.error === "service-not-allowed" ? "denied" : "failed");
    };
    r.onend = () => {
      if (rec.current !== r) return;
      if (wanted.current) {
        try {
          r.start();
          return;
        } catch {}
      }
      setListening(false);
      setHearing("");
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      wanted.current = false;
      cfg.current.onError?.("failed");
    }
  }, []);

  const start = useCallback(() => {
    if (wanted.current) return;
    wanted.current = true;
    begin();
  }, [begin]);

  // Another language: the session in the old one is ended and a new one begun.
  useEffect(() => {
    if (!wanted.current) return;
    const old = rec.current;
    rec.current = null;
    try {
      old?.abort();
    } catch {}
    begin();
  }, [opts.lang, begin]);

  // Leaving the screen stops the microphone.
  useEffect(
    () => () => {
      wanted.current = false;
      const r = rec.current;
      rec.current = null;
      try {
        r?.abort();
      } catch {}
    },
    []
  );

  return { supported, listening, hearing, start, stop };
}

export type TalkField = "complaint" | "exam" | "diagnosis" | "plan";

/*
  The section a phrase names, so one microphone fills the whole record: "…
  diagnosis, acute tonsillitis … plan, review in a week". The words that
  cannot be mistaken switch wherever they are said; "plan" and "exam" are
  ordinary words too ("I plan to…"), so they switch only when a phrase begins
  with them — said after a pause, as a heading is.
*/
const ANYWHERE: [RegExp, TalkField][] = [
  [/\b(?:chief )?complaint\b[\s:,.-]*/i, "complaint"],
  [/\b(?:on )?examination\b[\s:,.-]*/i, "exam"],
  [/\bdiagnosis\b[\s:,.-]*/i, "diagnosis"],
  [/(?:^|\s)(?:ال)?شكوى[\s:،,.-]*/, "complaint"],
  [/(?:^|\s)الفحص[\s:،,.-]*/, "exam"],
  [/(?:^|\s)التشخيص[\s:،,.-]*/, "diagnosis"],
  [/(?:^|\s)الخط[ةه][\s:،,.-]*/, "plan"],
];
const AT_START: [RegExp, TalkField][] = [
  [/^(?:the )?(?:treatment )?plan\b[\s:,.-]*/i, "plan"],
  [/^exam\b[\s:,.-]*/i, "exam"],
];

/** A phrase as the fields take it: each part with the section it belongs to (null: the one already open). */
export function routePhrase(phrase: string): { field: TalkField | null; text: string }[] {
  const out: { field: TalkField | null; text: string }[] = [];
  let rest = phrase.trim();
  let field: TalkField | null = null;
  for (const [re, f] of AT_START) {
    const m = re.exec(rest);
    if (m) {
      field = f;
      rest = rest.slice(m[0].length);
      break;
    }
  }
  for (;;) {
    let first: { at: number; len: number; field: TalkField } | null = null;
    for (const [re, f] of ANYWHERE) {
      const m = re.exec(rest);
      if (m && (!first || m.index < first.at)) first = { at: m.index, len: m[0].length, field: f };
    }
    if (!first) break;
    const before = rest.slice(0, first.at).trim();
    if (before || field) out.push({ field, text: before });
    field = first.field;
    rest = rest.slice(first.at + first.len);
  }
  out.push({ field, text: rest.trim() });
  return out.filter((p) => p.field || p.text);
}
