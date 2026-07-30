"use client";

import Link from "next/link";
import { useActionState, useEffect } from "react";
import { loginAction } from "./actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";

export function LoginForm({ next }: { next?: string }) {
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
        {state?.error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {t.auth.wrongCredentials}
          </p>
        )}
        <Button type="submit" size="lg" loading={busy}>
          {t.auth.signIn}
        </Button>
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
