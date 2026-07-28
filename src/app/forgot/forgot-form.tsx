"use client";

import { useActionState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { requestResetAction } from "./actions";

export function ForgotForm() {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(requestResetAction, null);

  // Always the same confirmation, whether or not the address exists — otherwise
  // this page becomes a way to discover which emails have accounts.
  if (state?.sent) {
    return (
      <div className="w-full max-w-[420px] rounded-modal border border-line bg-surface p-6 text-center shadow-modal">
        <h1 className="font-display text-xl font-semibold text-ink-900">{t.auth.resetSentTitle}</h1>
        <p className="mt-2 text-sm text-ink-500">{t.auth.resetSentBody}</p>
        {state.devUrl && (
          <p className="mt-4 break-all rounded-ctl bg-sunken px-3 py-2 text-start text-xs text-ink-700">
            {state.devUrl}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="grid w-full max-w-[420px] gap-4 rounded-modal border border-line bg-surface p-6 shadow-modal"
    >
      <div className="text-center">
        <h1 className="font-display text-xl font-semibold text-ink-900">{t.auth.forgotTitle}</h1>
        <p className="mt-1 text-sm text-ink-500">{t.auth.forgotSub}</p>
      </div>
      <Field label={t.common.email} required>
        <Input
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          placeholder={t.auth.emailPlaceholder}
          required
          autoFocus
        />
      </Field>
      <Button type="submit" size="lg" loading={pending}>
        {t.auth.sendResetLink}
      </Button>
    </form>
  );
}
