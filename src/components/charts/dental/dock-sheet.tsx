"use client";

/*
  The tooth panel on a phone or a tablet: docked to the bottom, over nothing.

  A modal sheet dimmed the chart and covered the very tooth being treated, so
  the doctor tapped "Composite filling" and saw the result only after closing
  it. This one leaves the chart above it lit and live — the page is scrolled so
  the tooth sits in the open part of the screen — and a treatment lands on the
  tooth in the panel and on the tooth in the chart at the same moment.

  The handle lifts it to nearly full height for the long lists, and drops it
  back. It sits above the phone's bottom bar (z-40) and under real modals.
*/

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/client";

/** The share of the screen the sheet takes when it opens. */
export const SHEET_SHARE = 0.56;

export function DockSheet({ open, label, children }: { open: boolean; label: string; children: React.ReactNode }) {
  const { dir, locale } = useI18n();
  const [tall, setTall] = useState(false);
  useEffect(() => {
    if (!open) setTall(false);
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      dir={dir}
      lang={locale}
      data-latin-island={dir === "ltr" || undefined}
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-[45] flex justify-center ${dir === "ltr" ? "font-sans" : ""}`}
    >
      <div
        role="dialog"
        aria-label={label}
        data-dental-sheet
        className={`pointer-events-auto flex w-full max-w-2xl flex-col rounded-t-modal border border-b-0 border-line bg-surface shadow-modal animate-fade-up transition-[height] duration-220 ease-out ${
          tall ? "h-[92dvh]" : "h-[56dvh]"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <button
          type="button"
          onClick={() => setTall((v) => !v)}
          aria-label={label}
          aria-expanded={tall}
          className="flex h-7 w-full shrink-0 touch-manipulation items-center justify-center"
        >
          <span className="h-1.5 w-11 rounded-full bg-line-strong" />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
