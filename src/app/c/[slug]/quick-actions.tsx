"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export type QuickAction = "appointment" | "patient" | "invoice" | "inbox";

/**
 * The four things a front desk does all day, one key away.
 *
 * Keyboard accelerators, because the people using this are on a desktop with a
 * patient in front of them, and reaching for the mouse to start a booking is
 * the slowest part of taking one.
 */
const SHORTCUTS: Record<QuickAction, { code: string; hint: string }> = {
  appointment: { code: "KeyA", hint: "A" },
  patient: { code: "KeyP", hint: "P" },
  invoice: { code: "KeyI", hint: "I" },
  inbox: { code: "KeyM", hint: "M" },
};

/** Where each action goes. Outside the component so the effect below can depend
 *  on `slug` alone rather than on an object rebuilt every render. */
export function hrefFor(slug: string, a: QuickAction): string {
  return {
    appointment: `/c/${slug}/calendar?new=1`,
    patient: `/c/${slug}/patients?new=1`,
    invoice: `/c/${slug}/invoices/new`,
    inbox: `/c/${slug}/conversations`,
  }[a];
}

/**
 * The accelerators, on every screen rather than only the dashboard: the shell
 * listens, for whatever this member may start. The dashboard's buttons only
 * show the letters.
 */
export function useQuickShortcuts(slug: string, actions: QuickAction[]) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
        `e.code`, not `e.key`. `code` is the physical key; `key` is the
        character the current layout produces — so on an Arabic keyboard the A
        key reports "ش" and every shortcut in an Arabic-first product would be
        dead. This is the whole reason the map above stores KeyA rather than "a".
      */
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      // Never steal a keystroke from somebody typing. contentEditable covers the
      // rich-text editors in documents and notes.
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      // A dialog owns the keyboard while it is open — Escape closes it, and a
      // stray "p" underneath it must not navigate the page out from under.
      if (document.querySelector('[role="dialog"]')) return;

      const hit = actions.find((a) => SHORTCUTS[a].code === e.code);
      if (!hit) return;
      e.preventDefault();
      router.push(hrefFor(slug, hit));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, router, slug]);
}
