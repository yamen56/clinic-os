"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLocaleAction } from "@/app/login/actions";
import { useI18n } from "@/lib/i18n/client";
import { Languages } from "lucide-react";

export function LanguageToggle({ compact, onDark }: { compact?: boolean; onDark?: boolean }) {
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
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors duration-140 ease-out ${
        onDark
          ? "border-white/12 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
          : "border-line bg-surface text-ink-700 hover:bg-sunken"
      }`}
    >
      <Languages className="h-4 w-4" strokeWidth={1.75} />
      {!compact && (next === "en" ? t.common.english : t.common.arabic)}
    </button>
  );
}
