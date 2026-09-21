"use client";

import { useI18n } from "@/lib/i18n/client";

/**
 * Apple's mark, drawn rather than fetched — for the same reasons as the Google
 * one: no remote asset on the page a user cannot get past, and the glyph has to
 * be Apple's own shape, not an approximation.
 */
function AppleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/**
 * Black fill, white mark, same height as the button beside it.
 *
 * Apple's Human Interface Guidelines are a review criterion, not a suggestion:
 * the button must use one of Apple's own fills and must be no less prominent
 * than any other sign-in option on the screen. Black on the white card is the
 * variant that holds on this surface, and the shared `h-11 w-full` is what keeps
 * "no less prominent" true rather than merely intended.
 *
 * The mark sits a hair above the optical centre of its box, which is how Apple
 * draws it; the small negative top margin puts it back on the text baseline.
 */
export function AppleButton({ next }: { next?: string }) {
  const { t } = useI18n();
  const href = `/api/auth/apple/start${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return (
    <a
      href={href}
      className="flex h-11 w-full items-center justify-center gap-2.5 rounded-ctl bg-black text-[14px] font-medium text-white transition-opacity hover:opacity-85"
    >
      <span className="-mt-px flex">
        <AppleMark />
      </span>
      <span>{t.auth.signInApple}</span>
    </a>
  );
}
