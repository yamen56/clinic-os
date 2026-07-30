"use client";

import { useActionState, useEffect } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";

export type SetPasswordState = { error?: string; to?: string } | null;

/**
 * Shared by invitation acceptance and password reset — both set a password
 * against a one-time token, and differ only in wording.
 */
export function SetPasswordForm({
  token,
  action,
  heading,
  sub,
  submitLabel,
}: {
  token: string;
  action: (prev: SetPasswordState, form: FormData) => Promise<SetPasswordState>;
  heading: string;
  sub: string;
  submitLabel: string;
}) {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(action, null);

  // Accepting an invitation signs the user in, so the same rule as /login
  // applies: leave for the destination with a full document load, carrying the
  // fresh cookie and no cached signed-out view of it. See app/login/actions.ts.
  useEffect(() => {
    if (state?.to) window.location.replace(state.to);
  }, [state?.to]);

  return (
    <form
      action={formAction}
      className="grid w-full max-w-[420px] gap-4 rounded-modal border border-line bg-surface p-6 shadow-modal"
    >
      <input type="hidden" name="token" value={token} />
      <div className="text-center">
        <h1 className="font-display text-xl font-semibold text-ink-900">{heading}</h1>
        <p className="mt-1 text-sm text-ink-500">{sub}</p>
      </div>

      <Field label={t.auth.newPassword} required>
        <Input
          name="password"
          type="password"
          dir="ltr"
          autoComplete="new-password"
          minLength={8}
          required
          autoFocus
        />
      </Field>
      <Field label={t.auth.confirmPassword} required>
        <Input
          name="confirm"
          type="password"
          dir="ltr"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </Field>

      <p className="-mt-1 text-xs text-ink-500">{t.auth.passwordHint}</p>

      {state?.error && (
        <p className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
          {(t.auth.errors as Record<string, string>)[state.error] ?? t.common.genericError}
        </p>
      )}

      <Button type="submit" size="lg" loading={pending || !!state?.to}>
        {submitLabel}
      </Button>
    </form>
  );
}
