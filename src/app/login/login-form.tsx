"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";

export function LoginForm() {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(loginAction, null);

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
        <Button type="submit" size="lg" loading={pending}>
          {t.auth.signIn}
        </Button>
      </form>
    </div>
  );
}
