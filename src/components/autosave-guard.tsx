"use client";

import { useCallback, useEffect, useRef, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  beginRouterRefresh,
  flushAllAutosaves,
  hasUnsavedWork,
  onAutosavesSettled,
  retryOrphanedAutosaves,
  routerIsStale,
} from "@/lib/use-autosave";

/** How long a link waits before going anyway. Whatever did not land is retried from storage. */
const HOLD_MS = 4000;
/** Quiet time after the last save before the page is re-fetched behind it. */
const SETTLE_MS = 800;

/**
 * Makes "Saved" survive leaving the screen.
 *
 * Two things went wrong between an autosave and the next screen, and each one
 * showed a receptionist the value they had just replaced:
 *
 *  1. **The link beat the save.** The edit sat in a 1.5s debounce, the click
 *     navigated at once, and the next page read the database first. A link
 *     clicked while anything is unsaved is now held until the save lands.
 *  2. **Back restored a snapshot.** The router keeps every page it has shown and
 *     restores it on Back without asking the server, so a page left after an
 *     edit came back exactly as it was before it. Once saves settle, the page
 *     is re-fetched in the background, which replaces that snapshot; client
 *     state is kept, so nothing being typed moves. A link clicked before that
 *     finishes waits for it, because a navigation cancels a refresh in flight.
 *
 * Back and Forward cannot be held. The page they arrive at is refreshed after
 * its saves land — which fixes a list showing an old name, though not a form
 * already restored from its snapshot. That needs somebody to press Back within
 * a second of typing, rather than every time.
 *
 * Mounted once, in the clinic layout.
 */
export function AutosaveGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const [refreshing, startRefresh] = useTransition();
  const waiters = useRef<(() => void)[]>([]);
  const firstPath = useRef(true);

  useEffect(() => {
    if (!refreshing) for (const done of waiters.current.splice(0)) done();
  }, [refreshing]);

  /** Re-fetch the current page, resolving once the router has applied it. */
  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        const finished = beginRouterRefresh();
        waiters.current.push(() => {
          finished();
          resolve();
        });
        startRefresh(() => router.refresh());
      }),
    [router]
  );

  // Behind every burst of saves, so the snapshot Back would restore is current.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onAutosavesSettled(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!hasUnsavedWork() && routerIsStale()) void refresh();
      }, SETTLE_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!hasUnsavedWork() && !routerIsStale()) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      // A new tab or a download leaves this page where it is.
      if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin || to.pathname.startsWith("/api/")) {
        void flushAllAutosaves({ keepalive: true });
        return;
      }
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;

      // Ahead of the Link's own handler: capture phase, on the document.
      e.preventDefault();
      e.stopPropagation();
      let gone = false;
      const go = () => {
        if (gone) return;
        gone = true;
        router.push(to.pathname + to.search + to.hash);
      };
      setTimeout(go, HOLD_MS);
      void (async () => {
        await flushAllAutosaves();
        if (routerIsStale()) await refresh();
      })().finally(go);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [refresh, router]);

  // After Back, Forward, or a navigation made in code rather than by a link.
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    let cancelled = false;
    void flushAllAutosaves().then(() => {
      if (!cancelled && routerIsStale()) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [pathname, refresh]);

  useEffect(() => {
    void retryOrphanedAutosaves();
    const onOnline = () => void retryOrphanedAutosaves();
    window.addEventListener("online", onOnline);
    const iv = setInterval(() => void retryOrphanedAutosaves(), 30_000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(iv);
    };
  }, []);

  return null;
}
