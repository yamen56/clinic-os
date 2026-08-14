"use client";

import Link from "next/link";
import { useActionState, useEffect } from "react";
import { loginAction } from "./actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { GoogleButton } from "@/components/google-button";

export function LoginForm({ next, google, oauthError }: { next?: string; google?: boolean; oauthError?: string }) {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(loginAction, null);

  /*
    A full document load, not router.push: the browser starts a fresh request
    with the session cookie and an empty router cache, so the workspace can't be
    answered from a payload rendered while signed out.
  */
  useEffect(() => {
    if (state?.to) window.location.replace(state.to);
  }, [state?.to]);

  // The navigation is still in flight after the action resolves — keep the
  // button busy rather than flashing back to idle under a loading page.
  const busy = pending || !!state?.to;

  return (
    <div className="w-full max-w-[420px]">
      <form
        action={formAction}
        className="grid gap-4 rounded-modal border border-line bg-surface p-6 shadow-modal"
      >
        <div className="mb-1 text-center">
          <h1 className="font-display text-xl font-semibold text-ink-900">{t.auth.signInTitle}</h1>
          <p className="mt-1 text-sm text-ink-500">{t.auth.signInSub}</p>
        </div>
        {next && <input type="hidden" name="next" value={next} />}
        <Field label={t.common.email} required>
          <Input name="email" type="email" dir="ltr" placeholder={t.auth.emailPlaceholder} autoComplete="email" required />
        </Field>
        <Field label={t.common.password} required>
          <Input name="password" type="password" dir="ltr" autoComplete="current-password" required />
        </Field>
        {(state?.error || oauthError) && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {oauthError
              ? oauthError === "google_no_account"
                ? t.auth.googleNoAccount
                : oauthError === "google_unverified"
                  ? t.auth.googleUnverified
                  : oauthError === "google_cancelled"
                    ? t.auth.googleCancelled
                    : t.auth.googleFailed
              : t.auth.wrongCredentials}
          </p>
        )}
        <Button type="submit" size="lg" loading={busy}>
          {t.auth.signIn}
        </Button>
        {/*
          Rendered only when the server has credentials configured. A button
          that leads to a redirect loop is worse than no button, so the absence
          of the env vars removes it rather than breaking it.
        */}
        {google && (
          <>
            <div className="flex items-center gap-3 text-[12px] text-ink-400">
              <span className="h-px flex-1 bg-line" />
              {t.auth.orDivider}
              <span className="h-px flex-1 bg-line" />
            </div>
            <GoogleButton next={next} />
          </>
        )}
        <Link
          href="/forgot"
          className="text-center text-[13px] text-ink-500 underline underline-offset-4 hover:text-ink-900"
        >
          {t.auth.forgotPassword}
        </Link>
      </form>
    </div>
  );
}
