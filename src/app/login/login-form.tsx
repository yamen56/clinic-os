"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { HeartPulse } from "lucide-react";

export function LoginForm() {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-card">
          <HeartPulse className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t.auth.signInTitle}</h1>
          <p className="mt-1 text-sm text-ink-500">{t.auth.signInSub}</p>
        </div>
      </div>
      <form action={formAction} className="grid gap-4 rounded-card border border-line bg-surface p-6 shadow-card">
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
