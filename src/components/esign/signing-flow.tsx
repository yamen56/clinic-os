"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n/client-dict";
import { useSignWords } from "@/components/esign/sign-words";
import { Button } from "@/components/ui/button";
import { DocumentBody } from "@/components/esign/document-body";
import { SignaturePad, type SignaturePadHandle, type Stroke } from "@/components/esign/signature-pad";
import { SigningChrome, StepIndicator } from "@/components/esign/signing-chrome";
import type { PublicSigningView } from "@/lib/esign/public";
import { QuestionInput } from "@/components/esign/question-input";
import { answerText, unanswered } from "@/lib/esign/questions";
import { Check, ChevronDown, WifiOff, CircleCheck, X } from "lucide-react";

/**
 * The signing journey, used by both a link on a phone and a tablet in the clinic.
 *
 * One component for both because the patient's experience is meant to be
 * identical: read to the end, tick one box, sign. The differences are the shell
 * around it and where the submission goes, and both arrive as props.
 *
 * Three things here are deliberate and easy to lose in a refactor:
 *
 *  - The continue button on step 1 stays inert until the document has actually
 *    been scrolled to the bottom. No hidden terms.
 *  - Progress is written to the server as they move, including a half-drawn
 *    signature, so abandoning the link and coming back resumes in place.
 *  - A submit that fails while offline never discards the signature. It retries
 *    on its own when the connection returns, and says so in the meantime.
 */

/** The journey's screens; "ask" exists only when the template asks before the text. */
type Screen = "ask" | "read" | "confirm" | "sign";

export type SubmitPayload = {
  png: string;
  svg: string | null;
  typedName: string | null;
  consentConfirmed: boolean;
  fieldAnswers: Record<string, unknown>;
};

export function SigningFlow({
  mode,
  token,
  view,
  locale,
  onSubmit,
  onDecline,
  onProgress,
  kioskFooter,
}: {
  mode: "remote" | "kiosk";
  token?: string;
  view: PublicSigningView;
  locale: Locale;
  /** Kiosk mode injects its own session-authenticated submit. */
  onSubmit?: (payload: SubmitPayload) => Promise<{ ok: boolean; error?: string; completed?: boolean }>;
  onDecline?: (reason: string) => Promise<{ ok: boolean }>;
  onProgress?: (p: { step: number; scrolledToEnd: boolean; consent: boolean; strokes: Stroke[] }) => void;
  kioskFooter?: React.ReactNode;
}) {
  const t = useSignWords();
  const resume = view.session;

  /*
    Where the questions and the patient's own details go (0114), as the template
    chose: on their own screen before the text, on the reading page under the
    text, or with the consent tick after it (the default). Nothing to ask, and
    the journey is the plain three steps.
  */
  const hasAsk = view.fills.length > 0 || view.extraQuestions.length > 0;
  const at = hasAsk ? view.questionsAt : "after";
  const screens: Screen[] = at === "before" ? ["ask", "read", "confirm", "sign"] : ["read", "confirm", "sign"];
  const stepOf = (s: Screen) => screens.indexOf(s) + 1;
  const stepLabels = screens.map((s) =>
    s === "ask" ? t.sign.stepAnswer : s === "read" ? t.sign.stepRead : s === "confirm" ? t.sign.stepConfirm : t.sign.stepSign
  );

  const [step, setStep] = useState(Math.min(Math.max(resume?.lastStep ?? 1, 1), screens.length));
  const screen = screens[step - 1] ?? "read";
  const [scrolledToEnd, setScrolledToEnd] = useState(resume?.scrolledToEnd ?? false);
  const [consent, setConsent] = useState(resume?.consentConfirmed ?? false);
  const [answers, setAnswers] = useState<Record<string, unknown>>(resume?.fieldAnswers ?? {});
  // Seeded from the resumed session: a signature already half-drawn is ink, and
  // the submit button has to be live the moment they come back to it.
  const [hasInk, setHasInk] = useState(
    ((resume?.partialSignature as { strokes?: unknown[] } | null)?.strokes?.length ?? 0) > 0
  );
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [codeVerified, setCodeVerified] = useState(view.state !== "needs_code");

  const padRef = useRef<SignaturePadHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingPayload = useRef<SubmitPayload | null>(null);

  const initialStrokes = (resume?.partialSignature as { strokes?: Stroke[] } | null)?.strokes;

  /* ------------------------------------------------------------- progress */

  const saveProgress = useCallback(
    (next: { step?: number; scrolledToEnd?: boolean; consent?: boolean; strokes?: Stroke[] }) => {
      const payload = {
        step: next.step ?? step,
        scrolledToEnd: next.scrolledToEnd ?? scrolledToEnd,
        consent: next.consent ?? consent,
        strokes: next.strokes ?? [],
      };
      if (onProgress) {
        onProgress(payload);
        return;
      }
      if (!token) return;
      // Fire and forget: losing a progress ping costs the patient one scroll,
      // and blocking the UI on it would cost far more.
      void fetch(`/api/public/sign/${token}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, fieldAnswers: answers }),
        keepalive: true,
      }).catch(() => {});
    },
    [answers, consent, onProgress, scrolledToEnd, step, token]
  );

  /* ------------------------------------------------------- scroll tracking */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || screen !== "read") return;

    const check = () => {
      // 24px of slack: on a phone the last line often sits a hair above the
      // bottom because of momentum scrolling and safe-area padding.
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atEnd && !scrolledToEnd) {
        setScrolledToEnd(true);
        saveProgress({ scrolledToEnd: true });
      }
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    return () => el.removeEventListener("scroll", check);
  }, [screen, scrolledToEnd, saveProgress]);

  /* --------------------------------------------------- offline resubmission */

  const doSubmit = useCallback(
    async (payload: SubmitPayload) => {
      setSubmitting(true);
      setError(null);
      try {
        let result: { ok: boolean; error?: string; completed?: boolean };
        if (onSubmit) {
          result = await onSubmit(payload);
        } else {
          const res = await fetch(`/api/public/sign/${token}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          result = await res.json().catch(() => ({ ok: false, error: "network" }));
          if (!res.ok) result.ok = false;
        }
        if (result.ok) {
          pendingPayload.current = null;
          setOffline(false);
          setDone(true);
          return;
        }
        setError(result.error ?? "generic");
      } catch {
        /*
          The signature is not lost. It stays in `pendingPayload` and the online
          listener below sends it again — someone in a clinic basement with one
          bar must not have to draw their name twice.
        */
        pendingPayload.current = payload;
        setOffline(true);
      } finally {
        setSubmitting(false);
      }
    },
    [onSubmit, token]
  );

  useEffect(() => {
    const retry = () => {
      if (pendingPayload.current) void doSubmit(pendingPayload.current);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [doSubmit]);

  /* ---------------------------------------------------------------- actions */

  const finish = () => {
    const value = padRef.current?.value();
    if (!value) {
      setError("bad_signature");
      return;
    }
    void doSubmit({
      png: value.png,
      svg: value.svg,
      typedName: value.typedName,
      consentConfirmed: consent,
      fieldAnswers: answers,
    });
  };

  const decline = async () => {
    setSubmitting(true);
    try {
      if (onDecline) {
        await onDecline(declineReason);
      } else if (token) {
        await fetch(`/api/public/sign/${token}/decline`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: declineReason }),
        });
      }
      setDeclineOpen(false);
      setDeclined(true);
    } finally {
      setSubmitting(false);
    }
  };

  const goTo = (n: number) => {
    setStep(n);
    saveProgress({ step: n, strokes: [] });
  };

  const requiredMissing = unanswered(view.extraQuestions, view.fills, answers).length > 0;

  /*
    The patient's missing details and the template's questions — the same block
    wherever the template put it. `bare` drops the card frames when it sits
    inside the reading box, under the text.
  */
  const askBlock = (bare: boolean) => {
    const frame = bare ? "grid" : "mt-4 grid rounded-card border border-line bg-surface p-4";
    return (
      <>
        {/* The details the clinic did not have yet — the patient's own, in their own hand. */}
        {view.fills.length > 0 && (
          <section className={`${frame} gap-3`} data-your-details>
            <div>
              <h2 className="text-[0.9375rem] font-semibold">{t.sign.yourDetails}</h2>
              <p className="mt-0.5 text-[0.75rem] leading-relaxed text-ink-500">{t.sign.yourDetailsSub}</p>
            </div>
            {view.fills.map((f) => (
              <div key={f.key}>
                <span className="mb-1.5 flex items-baseline gap-1 text-[0.8125rem] font-semibold">
                  {locale === "ar" ? f.label_ar || f.label : f.label || f.label_ar}
                  <span className="text-danger">*</span>
                </span>
                <QuestionInput qkey={f.key} type={f.type} options={f.options} answers={answers} onChange={setAnswers} words={t.sign} />
              </div>
            ))}
          </section>
        )}

        {view.extraQuestions.length > 0 && (
          <section className={`${frame} gap-4`} data-sign-questions>
            <h2 className="text-[0.9375rem] font-semibold">{t.sign.extraQuestions}</h2>
            {view.extraQuestions.map((q) => (
              <div key={q.key}>
                <span className="mb-1.5 flex items-baseline gap-1 text-[0.875rem] font-semibold leading-snug">
                  {locale === "ar" ? q.label_ar || q.label : q.label || q.label_ar}
                  {q.required && <span className="text-danger">*</span>}
                </span>
                <QuestionInput qkey={q.key} type={q.type} options={q.options} answers={answers} onChange={setAnswers} words={t.sign} />
              </div>
            ))}
          </section>
        )}
      </>
    );
  };

  /*
    Back on the document, the blanks show what the patient has typed so far —
    the frozen text keeps its marked blanks; this only paints them.
  */
  useEffect(() => {
    if (screen !== "read" || !view.fills.length) return;
    const lang = view.document?.language === "en" ? "en" : "ar";
    scrollRef.current?.querySelectorAll<HTMLElement>("[data-fill]").forEach((el) => {
      const key = el.dataset.fill ?? "";
      const fill = view.fills.find((f) => f.key === key);
      if (!fill) return;
      if (!el.dataset.label) el.dataset.label = el.textContent ?? "";
      const text = answerText(fill.type, answers[key], lang, undefined, key);
      el.textContent = text || el.dataset.label;
      el.classList.toggle("doc-filled", !!text);
    });
  }, [screen, answers, view.fills, view.document?.language]);

  /* -------------------------------------------------------- terminal screens */

  if (declined) {
    return (
      <SigningChrome clinic={view.clinic} locale={locale} credit={mode === "remote" ? "link" : "text"}>
        <Outcome
          tone="danger"
          icon={<X className="h-8 w-8" />}
          title={t.sign.declinedTitle}
          body={t.sign.declinedBody.replace("{clinic}", view.clinic?.name ?? "")}
          hint={t.sign.closeHint}
        />
      </SigningChrome>
    );
  }

  if (done) {
    return (
      <SigningChrome clinic={view.clinic} locale={locale} footer={kioskFooter} credit={mode === "remote" ? "link" : "text"}>
        <Outcome
          tone="ok"
          icon={<CircleCheck className="h-8 w-8" />}
          title={t.sign.thanksTitle}
          body={
            mode === "remote"
              ? t.sign.thanksBodyWa
              : t.sign.thanksBodyPlain.replace("{clinic}", view.clinic?.name ?? "")
          }
          extra={
            view.nextSignerName
              ? t.sign.thanksNext.replace("{name}", view.nextSignerName)
              : undefined
          }
          hint={mode === "remote" ? t.sign.closeHint : t.sign.kioskDone}
        />
      </SigningChrome>
    );
  }

  /*
    The code gate, when a clinic has asked for one. It sits in front of the whole
    flow rather than between steps: a signer who has to prove a number should not
    have read the document first.
  */
  if (!codeVerified && token) {
    return (
      <SigningChrome clinic={view.clinic} locale={locale} footer={kioskFooter} credit={mode === "remote" ? "link" : "text"}>
        <CodeGate token={token} locale={locale} onVerified={() => setCodeVerified(true)} />
      </SigningChrome>
    );
  }

  /* ------------------------------------------------------------------ steps */

  const greeting = view.signer?.displayName
    ? t.sign.greeting
        .replace("{name}", view.signer.displayName.split(/\s+/)[0])
        .replace("{clinic}", view.clinic?.name ?? "")
    : t.sign.greetingNoName.replace("{clinic}", view.clinic?.name ?? "");

  return (
    <SigningChrome clinic={view.clinic} locale={locale} footer={kioskFooter} credit={mode === "remote" ? "link" : "text"}>
      <StepIndicator step={step} locale={locale} labels={stepLabels} />

      {resume && resume.lastStep > 1 && step === resume.lastStep && (
        <p className="mb-3 rounded-ctl bg-brand-50 px-3 py-2 text-[0.75rem] font-medium text-brand-800">
          {t.sign.resumed}
        </p>
      )}

      {/* Questions first, when the clinic wants the answers before the patient reads. */}
      {screen === "ask" && (
        <>
          <h1 className="font-display text-xl font-bold">{view.document?.title}</h1>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-500">{greeting}</p>
          {askBlock(false)}
          <div className="mt-5 grid gap-2">
            <Button size="lg" className="h-12 w-full" disabled={requiredMissing} onClick={() => goTo(stepOf("read"))}>
              {t.sign.continue}
            </Button>
            {requiredMissing && <p className="text-center text-[0.75rem] text-ink-500">{t.sign.answerAll}</p>}
            <div className="flex justify-end">
              <button onClick={() => setDeclineOpen(true)} className="text-[0.8125rem] font-medium text-danger underline">
                {t.sign.decline}
              </button>
            </div>
          </div>
        </>
      )}

      {screen === "read" && (
        <>
          <h1 className="font-display text-xl font-bold">{view.document?.title}</h1>
          {at !== "before" && <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-500">{greeting}</p>}

          <div
            ref={scrollRef}
            className="relative mt-4 max-h-[58dvh] overflow-y-auto rounded-card border border-line bg-surface p-4 text-[0.9375rem] leading-[1.85] sm:p-5"
          >
            {view.document?.source === "upload" && token ? (
              <PdfPreview src={`/api/public/sign/${token}/pdf`} onEnd={() => setScrolledToEnd(true)} />
            ) : (
              <DocumentBody html={view.document?.snapshot ?? ""} />
            )}
            {/* On the same page as the text: read it, then answer under it, in one scroll. */}
            {at === "with" && (
              <div className="mt-6 grid gap-5 border-t border-line pt-5 leading-normal" data-ask-with-text>
                {askBlock(true)}
              </div>
            )}
          </div>

          <div className="sticky bottom-0 -mx-4 mt-3 bg-gradient-to-t from-paper via-paper px-4 pb-3 pt-2 sm:-mx-6 sm:px-6">
            {!scrolledToEnd ? (
              <button
                onClick={() =>
                  scrollRef.current?.scrollTo({
                    top: scrollRef.current.scrollHeight,
                    behavior: "smooth",
                  })
                }
                className="flex h-12 w-full items-center justify-center gap-2 rounded-ctl border border-line bg-surface text-[0.875rem] font-semibold text-ink-500"
              >
                <ChevronDown className="h-4 w-4 animate-bounce" />
                {t.sign.scrollToEnd}
              </button>
            ) : (
              <Button
                size="lg"
                className="h-12 w-full"
                disabled={at === "with" && requiredMissing}
                onClick={() => goTo(stepOf("confirm"))}
              >
                {t.sign.continue}
              </Button>
            )}
            {scrolledToEnd && at === "with" && requiredMissing && (
              <p className="mt-1.5 text-center text-[0.75rem] text-ink-500">{t.sign.answerAll}</p>
            )}
            {at === "before" && (
              <button onClick={() => goTo(stepOf("ask"))} className="mt-2 text-[0.8125rem] font-medium text-ink-500 underline">
                {t.sign.back}
              </button>
            )}
          </div>
        </>
      )}

      {screen === "confirm" && (
        <>
          <h1 className="font-display text-lg font-bold">{t.sign.consentTitle}</h1>

          {at === "after" && askBlock(false)}

          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-card border-2 border-line bg-surface p-4 transition-colors has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/50">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked);
                saveProgress({ consent: e.target.checked });
              }}
              className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600"
            />
            <span className="text-[0.875rem] leading-relaxed">{t.sign.consentLabel}</span>
          </label>

          <div className="mt-5 grid gap-2">
            <Button
              size="lg"
              className="h-12 w-full"
              disabled={!consent || requiredMissing}
              onClick={() => goTo(stepOf("sign"))}
            >
              {t.sign.continue}
            </Button>
            {requiredMissing ? (
              <p className="text-center text-[0.75rem] text-ink-500">{t.sign.answerAll}</p>
            ) : (
              !consent && <p className="text-center text-[0.75rem] text-ink-500">{t.sign.consentRequired}</p>
            )}
            <div className="flex items-center justify-between">
              <button onClick={() => goTo(stepOf("read"))} className="text-[0.8125rem] font-medium text-ink-500 underline">
                {t.sign.back}
              </button>
              <button
                onClick={() => setDeclineOpen(true)}
                className="text-[0.8125rem] font-medium text-danger underline"
              >
                {t.sign.decline}
              </button>
            </div>
          </div>
        </>
      )}

      {screen === "sign" && (
        <>
          <h1 className="font-display text-lg font-bold">{t.sign.signTitle}</h1>
          <div className="mt-3">
            <SignaturePad
              ref={padRef}
              locale={locale}
              initialStrokes={initialStrokes}
              suggestedName={view.signer?.displayName}
              onChange={(ink) => {
                setHasInk(ink);
                // Persist the strokes, not the rendered image: resuming has to put
                // the pen back where it was, not show a picture of it. Called at
                // the end of every stroke, so what is stored is what was drawn.
                const strokes = padRef.current?.strokes();
                if (strokes?.length) saveProgress({ step: stepOf("sign"), strokes });
              }}
            />
          </div>

          {error && (
            <p className="mt-3 rounded-ctl bg-danger-soft px-3 py-2 text-[0.8125rem] font-medium text-danger">
              {(t.docs.errors as Record<string, string>)[error] ?? t.common.genericError}
            </p>
          )}
          {offline && (
            <div className="mt-3 flex items-start gap-2 rounded-ctl bg-st-pending-soft px-3 py-2.5 text-st-pending">
              <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <div className="text-[0.8125rem] font-semibold">{t.sign.offlineTitle}</div>
                <p className="text-[0.75rem]">{t.sign.offlineBody}</p>
                <button
                  onClick={() => pendingPayload.current && void doSubmit(pendingPayload.current)}
                  className="mt-1 text-[0.75rem] font-semibold underline"
                >
                  {t.sign.retryNow}
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 grid gap-2">
            <Button
              size="lg"
              className="h-12 w-full"
              disabled={!hasInk || submitting}
              loading={submitting}
              onClick={finish}
            >
              <Check className="h-4 w-4" />
              {submitting ? t.sign.submitting : t.sign.finish}
            </Button>
            <div className="flex items-center justify-between">
              <button onClick={() => goTo(stepOf("confirm"))} className="text-[0.8125rem] font-medium text-ink-500 underline">
                {t.sign.back}
              </button>
              <button
                onClick={() => setDeclineOpen(true)}
                className="text-[0.8125rem] font-medium text-danger underline"
              >
                {t.sign.decline}
              </button>
            </div>
          </div>
        </>
      )}

      {declineOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <div className="absolute inset-0 bg-[rgb(11_18_32/0.55)]" onClick={() => setDeclineOpen(false)} />
          <div className="relative w-full rounded-t-modal bg-surface p-5 shadow-modal animate-fade-up sm:max-w-md sm:rounded-modal">
            <h2 className="font-display text-lg font-semibold">{t.sign.declineTitle}</h2>
            <p className="mt-1 text-[0.8125rem] text-ink-500">{t.sign.declineBody}</p>
            <label className="mt-3 block">
              <span className="mb-1.5 block text-[0.8125rem] font-semibold">{t.sign.declineReason}</span>
              <textarea
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                className="min-h-20 w-full rounded-ctl border border-line bg-surface px-3 py-2 text-[0.9375rem]"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeclineOpen(false)}>
                {t.common.cancel}
              </Button>
              <Button variant="danger" loading={submitting} onClick={decline}>
                {t.sign.declineConfirm}
              </Button>
            </div>
          </div>
        </div>
      )}
    </SigningChrome>
  );
}

/** The optional WhatsApp code screen. Only ever reached when a clinic enables it. */
function CodeGate({
  token,
  locale,
  onVerified,
}: {
  token: string;
  locale: Locale;
  onVerified: () => void;
}) {
  const t = useSignWords();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const call = async (payload: object) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/public/sign/${token}/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setErr(data.error ?? "generic");
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // Send on arrival: making them tap "send me a code" before they can type one
    // is a step that carries no information.
    void call({}).then((ok) => ok && setSent(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-[60dvh] flex-col justify-center">
      <h1 className="font-display text-xl font-bold">{t.sign.codeTitle}</h1>
      <p className="mt-1 text-[0.8125rem] text-ink-500">{t.sign.codeHint}</p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        placeholder={t.sign.codePlaceholder}
        aria-label={t.sign.codePlaceholder}
        className="mt-4 h-14 w-full rounded-ctl border border-line bg-surface text-center text-2xl font-semibold tracking-[0.4em] tnum outline-none focus:border-brand-600"
      />
      {err && (
        <p className="mt-2 text-[0.8125rem] font-medium text-danger">
          {err === "wrong_code"
            ? t.sign.codeWrong
            : err === "expired_code"
              ? t.sign.codeExpired
              : t.common.genericError}
        </p>
      )}
      <Button
        size="lg"
        className="mt-4 h-12"
        loading={busy}
        disabled={code.length < 6}
        onClick={() => void call({ code }).then((ok) => ok && onVerified())}
      >
        {t.sign.verify}
      </Button>
      {sent && (
        <button
          onClick={() => void call({})}
          className="mt-3 text-center text-[0.8125rem] font-medium text-ink-500 underline"
        >
          {t.sign.requestNewLink}
        </button>
      )}
    </div>
  );
}

function Outcome({
  tone,
  icon,
  title,
  body,
  extra,
  hint,
}: {
  tone: "ok" | "danger";
  icon: React.ReactNode;
  title: string;
  body: string;
  extra?: string;
  hint?: string;
}) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-center">
      <span
        className={`grid h-16 w-16 place-items-center rounded-full ${
          tone === "ok" ? "bg-st-confirmed-soft text-st-confirmed" : "bg-danger-soft text-danger"
        }`}
      >
        {icon}
      </span>
      <h1 className="font-display text-xl font-bold">{title}</h1>
      <p className="max-w-sm text-[0.875rem] leading-relaxed text-ink-700">{body}</p>
      {extra && <p className="max-w-sm text-[0.8125rem] text-ink-500">{extra}</p>}
      {hint && <p className="mt-2 text-[0.75rem] text-ink-400">{hint}</p>}
    </div>
  );
}

/**
 * An uploaded PDF, shown in the browser's own viewer.
 *
 * The scroll position inside an embedded viewer is not observable from outside
 * it, so "scroll to the end" cannot be enforced the same way. The button is
 * enabled once the file has loaded and the patient has had it on screen —
 * pretending to measure something we cannot see would be worse than saying so.
 */
function PdfPreview({ src, onEnd }: { src: string; onEnd: () => void }) {
  return (
    <object
      data={src}
      type="application/pdf"
      className="h-[52dvh] w-full"
      onLoad={onEnd}
      aria-label="PDF"
    >
      <iframe src={src} className="h-[52dvh] w-full border-0" onLoad={onEnd} title="PDF" />
    </object>
  );
}
