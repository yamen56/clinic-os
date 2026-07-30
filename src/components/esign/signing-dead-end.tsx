"use client";

import { useState, useTransition } from "react";
import { dictFor, type Locale } from "@/lib/i18n/client-dict";
import { Button } from "@/components/ui/button";
import { SigningChrome } from "@/components/esign/signing-chrome";
import type { PublicSigningView } from "@/lib/esign/public";
import { Clock, Ban, CircleCheck, Link2, SearchX, ShieldAlert, MailCheck, Hourglass } from "lucide-react";

/**
 * Every state a link can land in other than "sign now".
 *
 * The rule from the brief is that nothing is a dead end, and it is taken
 * literally: an expired link offers to ask the clinic for a new one and tells
 * them it was asked for; a revoked one points at WhatsApp; a link whose turn has
 * not come names who is signing first. The alternative — a bare error — is what
 * makes a patient phone the clinic.
 */
export function SigningDeadEnd({
  view,
  locale,
  token,
}: {
  view: PublicSigningView;
  locale: Locale;
  token: string;
}) {
  const t = dictFor(locale);
  const [requested, setRequested] = useState(false);
  const [pending, start] = useTransition();
  const clinicName = view.clinic?.name ?? "";

  const requestNew = () =>
    start(async () => {
      await fetch(`/api/public/sign/${token}/request-link`, { method: "POST" }).catch(() => {});
      setRequested(true);
    });

  if (requested) {
    return (
      <Shell view={view} locale={locale}>
        <Panel
          tone="ok"
          icon={<MailCheck className="h-8 w-8" />}
          title={t.sign.requestedTitle}
          body={t.sign.requestedBody}
        />
      </Shell>
    );
  }

  const screens: Record<
    string,
    { tone: "ok" | "danger" | "warning"; icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }
  > = {
    expired: {
      tone: "warning",
      icon: <Clock className="h-8 w-8" />,
      title: t.sign.expiredTitle,
      body: t.sign.expiredBody,
      action: (
        <Button size="lg" loading={pending} onClick={requestNew}>
          {t.sign.requestNewLink}
        </Button>
      ),
    },
    revoked: {
      tone: "warning",
      icon: <Link2 className="h-8 w-8" />,
      title: t.sign.revokedTitle,
      body: t.sign.revokedBody,
      action: (
        <Button size="lg" variant="outline" loading={pending} onClick={requestNew}>
          {t.sign.requestNewLink}
        </Button>
      ),
    },
    used: {
      tone: "ok",
      icon: <CircleCheck className="h-8 w-8" />,
      title: t.sign.usedTitle,
      body: t.sign.usedBody.replace("{clinic}", clinicName),
    },
    already_signed: {
      tone: "ok",
      icon: <CircleCheck className="h-8 w-8" />,
      title: t.sign.usedTitle,
      body: t.sign.usedBody.replace("{clinic}", clinicName),
    },
    declined: {
      tone: "danger",
      icon: <Ban className="h-8 w-8" />,
      title: t.sign.declinedTitle,
      body: t.sign.declinedBody.replace("{clinic}", clinicName),
    },
    voided: {
      tone: "danger",
      icon: <Ban className="h-8 w-8" />,
      title: t.sign.voidedTitle,
      body: t.sign.voidedBody.replace("{clinic}", clinicName),
    },
    throttled: {
      tone: "danger",
      icon: <ShieldAlert className="h-8 w-8" />,
      title: t.sign.tooManyTitle,
      body: t.sign.tooManyBody,
      action: (
        <Button size="lg" variant="outline" loading={pending} onClick={requestNew}>
          {t.sign.requestNewLink}
        </Button>
      ),
    },
    not_your_turn: {
      tone: "warning",
      icon: <Hourglass className="h-8 w-8" />,
      title: t.docs.notYourTurn.replace("{name}", view.waitingOn ?? ""),
      body: t.sign.closeHint,
    },
    not_found: {
      tone: "danger",
      icon: <SearchX className="h-8 w-8" />,
      title: t.sign.notFoundTitle,
      body: t.sign.notFoundBody,
    },
  };

  const s = screens[view.state] ?? screens.not_found;

  return (
    <Shell view={view} locale={locale}>
      <Panel tone={s.tone} icon={s.icon} title={s.title} body={s.body} action={s.action} />
    </Shell>
  );
}

function Shell({
  view,
  locale,
  children,
}: {
  view: PublicSigningView;
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <SigningChrome clinic={view.clinic} locale={locale}>
      {children}
    </SigningChrome>
  );
}

function Panel({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: "ok" | "danger" | "warning";
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const tones = {
    ok: "bg-st-confirmed-soft text-st-confirmed",
    danger: "bg-danger-soft text-danger",
    warning: "bg-st-pending-soft text-st-pending",
  };
  return (
    <div className="flex min-h-[62dvh] flex-col items-center justify-center gap-3 text-center">
      <span className={`grid h-16 w-16 place-items-center rounded-full ${tones[tone]}`}>{icon}</span>
      <h1 className="font-display text-xl font-bold">{title}</h1>
      <p className="max-w-sm text-[14px] leading-relaxed text-ink-700">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
