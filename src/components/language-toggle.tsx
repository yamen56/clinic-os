"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { LOCALE_COOKIE } from "@/lib/i18n/shared";
import { Languages } from "lucide-react";

export function LanguageToggle({
  compact,
  onDark,
  rail,
  onHint,
  onHintEnd,
}: {
  compact?: boolean;
  onDark?: boolean;
  /** A bare 32px icon for the folded sidebar, which labels it with its own tooltip. */
  rail?: boolean;
  onHint?: (e: React.SyntheticEvent<HTMLElement>, label: string) => void;
  onHintEnd?: () => void;
}) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const next = locale === "ar" ? "en" : "ar";

  /*
    The click does no network work at all.

    Writing the cookie in the browser removes a whole server round trip that
    existed only to set it, and flipping dir/lang mirrors the layout on the spot.
    The refresh that follows swaps the server-rendered text, but by then the
    change the eye tracks has already happened, so the button responds instantly
    instead of appearing stuck.
  */
  const toggle = () => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${365 * 86400}; samesite=lax`;
    const el = document.documentElement;
    el.dir = next === "ar" ? "rtl" : "ltr";
    el.lang = next;
    start(() => router.refresh());
  };

  if (rail) {
    const label = next === "en" ? t.common.english : t.common.arabic;
    return (
      <button
        type="button"
        onClick={toggle}
        aria-busy={pending || undefined}
        aria-label={label}
        onMouseEnter={onHint ? (e) => onHint(e, label) : undefined}
        onFocus={onHint ? (e) => onHint(e, label) : undefined}
        onMouseLeave={onHintEnd}
        onBlur={onHintEnd}
        className="grid h-8 w-8 touch-manipulation place-items-center rounded-ctl text-white/55 transition-colors duration-140 ease-out hover:bg-white/8 hover:text-white"
      >
        <Languages className="h-4.5 w-4.5" strokeWidth={1.75} />
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      aria-busy={pending || undefined}
      className={`inline-flex touch-manipulation items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors duration-140 ease-out select-none active:translate-y-px ${
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
