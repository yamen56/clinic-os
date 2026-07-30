"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { dictFor, type Locale } from "@/lib/i18n/client-dict";
import { Button } from "@/components/ui/button";
import { SigningChrome } from "@/components/esign/signing-chrome";
import { SigningFlow, type SubmitPayload } from "@/components/esign/signing-flow";
import type { PublicSigningView } from "@/lib/esign/public";
import {
  releaseInPersonAction,
  verifyKioskUnlockAction,
} from "@/app/c/[slug]/documents/actions";
import { Lock, Tablet, Hourglass, CircleCheck, X } from "lucide-react";

/**
 * The clinic tablet.
 *
 * Three things make this different from the remote page, and all three exist
 * because the device is about to leave the staff member's hands:
 *
 *  1. Nothing navigates. Back and forward gestures are neutralised, and there is
 *     no link anywhere on screen.
 *  2. Leaving requires the staff member's PIN (their password if they have not
 *     set one), which also releases the document's lock.
 *  3. There is a hand-over screen first, so staff pass over a device that is
 *     already showing the right document rather than fumbling in front of the
 *     patient.
 */
export function KioskSigning({
  slug,
  docId,
  signerId,
  hasPin,
  view,
}: {
  slug: string;
  docId: string;
  signerId: string;
  hasPin: boolean;
  view: PublicSigningView;
}) {
  const locale = (view.document?.language ?? "ar") as Locale;
  const t = dictFor(locale);
  const router = useRouter();

  /*
    No hand-over gate.

    An earlier version opened on a "hand the device to X — tap Start" screen. It
    read well and cost the patient a tap they were never budgeted, and it was the
    wrong tap: the brief has staff tap "Sign on this device" and hand over a
    device that is already showing the document. So the instruction became a strip
    at the top of step 1 that staff read over the patient's shoulder, and the
    containment below arms immediately instead.
  */
  const [handoverSeen, setHandoverSeen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [unlockError, setUnlockError] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
    Back-gesture containment.

    A patient swiping back must not reach the CRM. An extra history entry is
    pushed on mount and re-pushed whenever one is consumed, so `back` lands here
    again instead of on the previous page. This is not a security boundary on its
    own — the exit gate below is — but it stops the accident, which is what
    actually happens in a waiting room.
  */
  useEffect(() => {
    history.pushState({ kiosk: true }, "");
    const onPop = () => history.pushState({ kiosk: true }, "");
    window.addEventListener("popstate", onPop);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  /* Tell the record the patient has it open, once. */
  useEffect(() => {
    void fetch(`/api/c/${slug}/documents/${docId}/sign-in-person`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signerId }),
    }).catch(() => {});
  }, [slug, docId, signerId]);

  const submit = useCallback(
    async (payload: SubmitPayload) => {
      const res = await fetch(`/api/c/${slug}/documents/${docId}/sign-in-person`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signerId, ...payload }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        completed?: boolean;
      };
      // A non-ok response is a real refusal (hash mismatch, wrong turn) and must
      // surface. A thrown fetch is a connection problem, which SigningFlow keeps
      // and retries — so it is deliberately not caught here.
      return { ok: !!data.ok, error: data.error, completed: data.completed };
    },
    [slug, docId, signerId]
  );

  const decline = useCallback(
    async (reason: string) => {
      const res = await fetch(`/api/c/${slug}/documents/${docId}/sign-in-person`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signerId, decline: true, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return { ok: !!data.ok };
    },
    [slug, docId, signerId]
  );

  const unlock = async () => {
    setBusy(true);
    setUnlockError(false);
    try {
      const r = await verifyKioskUnlockAction(slug, secret);
      if (!r.ok) {
        setUnlockError(true);
        setSecret("");
        return;
      }
      await releaseInPersonAction(slug, docId);
      // Replace rather than push: the kiosk entry should not be reachable by a
      // forward gesture once staff are back in the workspace.
      router.replace(`/c/${slug}/documents/${docId}`);
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------------------------------- not signable states */

  if (view.state === "not_your_turn") {
    return (
      <SigningChrome clinic={view.clinic} locale={locale}>
        <Centered
          icon={<Hourglass className="h-8 w-8" />}
          title={t.docs.notYourTurn.replace("{name}", view.waitingOn ?? "")}
          action={<Button onClick={() => setUnlockOpen(true)}>{t.sign.kioskExit}</Button>}
        />
        <UnlockSheet
          open={unlockOpen}
          onClose={() => setUnlockOpen(false)}
          {...{ t, hasPin, secret, setSecret, unlockError, busy, unlock }}
        />
      </SigningChrome>
    );
  }

  if (view.state === "already_signed" || view.state === "declined") {
    return (
      <SigningChrome clinic={view.clinic} locale={locale}>
        <Centered
          icon={<CircleCheck className="h-8 w-8" />}
          title={view.state === "declined" ? t.sign.declinedTitle : t.sign.thanksTitle}
          body={t.sign.kioskDone}
          action={<Button onClick={() => setUnlockOpen(true)}>{t.sign.kioskExit}</Button>}
        />
        <UnlockSheet
          open={unlockOpen}
          onClose={() => setUnlockOpen(false)}
          {...{ t, hasPin, secret, setSecret, unlockError, busy, unlock }}
        />
      </SigningChrome>
    );
  }

  /* ---------------------------------------------------------- the flow */

  return (
    <>
      {!handoverSeen && (
        <div className="fixed inset-x-0 top-0 z-40 flex items-start gap-2.5 bg-brand-700 px-4 py-2.5 text-white">
          <Tablet className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">
              {t.sign.kioskHandOver.replace("{name}", view.signer?.displayName ?? "")}
            </div>
            <p className="text-[11px] opacity-80">{t.sign.kioskHandOverHint}</p>
          </div>
          <button
            onClick={() => setHandoverSeen(true)}
            aria-label={t.common.close}
            className="shrink-0 rounded p-1 hover:bg-white/15"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <SigningFlow
        mode="kiosk"
        view={view}
        locale={locale}
        onSubmit={submit}
        onDecline={decline}
        onProgress={(p) => {
          // Progress on a clinic device is kept for the same reason as remote: a
          // patient who puts the tablet down mid-signature loses nothing.
          void fetch(`/api/c/${slug}/documents/${docId}/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signerId, ...p }),
            keepalive: true,
          }).catch(() => {});
        }}
        kioskFooter={
          <div className="shrink-0 px-4 pb-2 text-center">
            <button
              onClick={() => setUnlockOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-ink-400 hover:bg-sunken"
            >
              <Lock className="h-3.5 w-3.5" />
              {t.sign.kioskExit}
            </button>
          </div>
        }
      />
      <UnlockSheet
        open={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        {...{ t, hasPin, secret, setSecret, unlockError, busy, unlock }}
      />
    </>
  );
}

function Centered({
  icon,
  title,
  body,
  extra,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body?: string;
  extra?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-brand-100 text-brand-700">
        {icon}
      </span>
      <h1 className="font-display text-2xl font-bold">{title}</h1>
      {extra && <p className="text-[15px] font-semibold text-ink-700">{extra}</p>}
      {body && <p className="max-w-sm text-[14px] leading-relaxed text-ink-500">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** The exit gate. A patient cannot leave this screen; a staff member can. */
function UnlockSheet({
  open,
  onClose,
  t,
  hasPin,
  secret,
  setSecret,
  unlockError,
  busy,
  unlock,
}: {
  open: boolean;
  onClose: () => void;
  t: ReturnType<typeof dictFor>;
  hasPin: boolean;
  secret: string;
  setSecret: (v: string) => void;
  unlockError: boolean;
  busy: boolean;
  unlock: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-[rgb(11_18_32/0.65)]" onClick={onClose} />
      <div className="relative w-full rounded-t-modal bg-surface p-5 shadow-modal animate-fade-up sm:max-w-sm sm:rounded-modal">
        <h2 className="font-display text-lg font-semibold">{t.sign.kioskExitTitle}</h2>
        <p className="mt-1 text-[13px] text-ink-500">
          {hasPin ? t.sign.kioskPinHint : t.sign.kioskPasswordHint}
        </p>
        <input
          type={hasPin ? "tel" : "password"}
          inputMode={hasPin ? "numeric" : undefined}
          autoFocus
          value={secret}
          onChange={(e) => setSecret(hasPin ? e.target.value.replace(/\D/g, "").slice(0, 8) : e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && unlock()}
          aria-label={hasPin ? t.sign.kioskPin : t.sign.kioskPassword}
          dir="ltr"
          className={`mt-3 h-12 w-full rounded-ctl border bg-surface px-3 text-center text-lg tracking-[0.3em] tnum outline-none ${
            unlockError ? "border-danger" : "border-line focus:border-brand-600"
          }`}
        />
        {unlockError && <p className="mt-2 text-[13px] font-medium text-danger">{t.sign.kioskWrong}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button loading={busy} disabled={!secret} onClick={unlock}>
            {t.sign.kioskExit}
          </Button>
        </div>
      </div>
    </div>
  );
}
