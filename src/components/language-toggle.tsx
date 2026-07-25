"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLocaleAction } from "@/app/login/actions";
import { useI18n } from "@/lib/i18n/client";
import { Languages } from "lucide-react";

export function LanguageToggle({ compact }: { compact?: boolean }) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const next = locale === "ar" ? "en" : "ar";

  return (
    <button
      onClick={() =>
        start(async () => {
          await setLocaleAction(next);
          router.refresh();
        })
      }
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-700 transition-colors hover:bg-paper"
    >
      <Languages className="h-4 w-4" />
      {!compact && (next === "en" ? t.common.english : t.common.arabic)}
    </button>
  );
}
