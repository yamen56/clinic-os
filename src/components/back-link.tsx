"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { ArrowLeft } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { browserWentTo, expectBack, previousPage, recordVisit, subscribeTrail } from "@/lib/nav-trail";

/**
 * Writes each page this tab arrives at into the trail. Mounted once, in the
 * root layout, inside a Suspense boundary: `useSearchParams` needs one, and
 * the query is worth keeping — Back to a filtered list should come back
 * filtered.
 */
export function NavTrailRecorder() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // The browser's Back (or a phone's swipe), which never passes through our button.
  // By the time `popstate` fires, `location` is already the page being returned to.
  useEffect(() => {
    const onPop = () => browserWentTo(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    recordVisit(search ? `${pathname}?${search}` : pathname);
  }, [pathname, search]);
  return null;
}

/**
 * Where Back goes from this page: the page before it in this tab, when there is
 * one inside `scope`, otherwise `fallback` — the page above this one. The
 * server renders the fallback; the trail only exists in the browser.
 */
export function useBackHref(fallback: string, scope: string): string {
  const pathname = usePathname();
  return useSyncExternalStore(
    subscribeTrail,
    () => previousPage(pathname, scope) ?? fallback,
    () => fallback
  );
}

/**
 * The Back control. A link, not a `router.back()`, so it fetches the page it
 * returns to instead of restoring a stale copy, and AutosaveGuard can hold it
 * while a save is still on its way like any other link.
 *
 * `label` names the destination when it is a section ("Patients"); for any
 * other page it is plain "Back". `icon` is the phone's top-bar form: the arrow
 * alone, at a thumb-sized 40px.
 */
export function BackLink({ href, label, icon = false }: { href: string; label: string; icon?: boolean }) {
  const { t } = useI18n();
  const spoken = label === t.common.back ? label : `${t.common.back}: ${label}`;
  // A plain click is a Back; a ctrl- or middle-click opens a new tab and leaves this one where it is.
  const onClick = (e: React.MouseEvent) => {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) expectBack(href);
  };
  if (icon) {
    return (
      <Link
        href={href}
        onClick={onClick}
        aria-label={spoken}
        title={spoken}
        data-back
        className="-ms-2 grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full text-ink-700 transition-colors duration-140 ease-out active:bg-sunken"
      >
        <ArrowLeft className="h-5 w-5 rtl:rotate-180" strokeWidth={1.75} />
      </Link>
    );
  }
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label={spoken}
      data-back
      className="-ms-2 inline-flex h-9 touch-manipulation items-center gap-1.5 rounded-ctl px-2 text-[13px] font-medium text-ink-500 transition-colors duration-140 ease-out hover:bg-sunken hover:text-ink-900"
    >
      <ArrowLeft className="h-4 w-4 shrink-0 rtl:rotate-180" />
      {label}
    </Link>
  );
}
