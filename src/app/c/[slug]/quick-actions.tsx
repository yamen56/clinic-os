"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { QUICK_KEYS, quickHref, type QuickAction } from "@/lib/quick-keys";

export type { QuickAction };

/** Where each action goes (lib/quick-keys). */
export const hrefFor = quickHref;

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
        dead. This is the whole reason lib/quick-keys stores KeyA rather than "a".
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

      const hit = actions.find((a) => QUICK_KEYS[a].code === e.code);
      if (!hit) return;
      e.preventDefault();
      router.push(hrefFor(slug, hit));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, router, slug]);
}
