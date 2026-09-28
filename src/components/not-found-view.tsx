"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SearchX } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { buttonClass } from "@/components/ui/button-class";

/**
 * "Not found", in the visitor's language.
 *
 * There was no not-found page, so every `notFound()` fell through to Next's
 * default: an English "This page could not be found" in place of the whole
 * workspace, sidebar included. Inside a clinic the way back is its dashboard;
 * anywhere else it is the start, which sends a visitor on to wherever they
 * belong.
 */
export function NotFoundView({ fullHeight = false }: { fullHeight?: boolean }) {
  const { t } = useI18n();
  const clinic = usePathname()?.match(/^\/c\/([^/]+)/)?.[1];
  // Inside the workspace the shell already owns the page's <main>.
  const Root = fullHeight ? "main" : "div";

  return (
    <Root
      className={`flex flex-col items-center justify-center gap-4 p-6 text-center ${
        fullHeight ? "min-h-dvh" : "min-h-[60vh]"
      }`}
    >
      <SearchX className="h-12 w-12 text-ink-400" strokeWidth={1.5} />
      <h1 className="text-xl font-semibold">{t.common.notFoundTitle}</h1>
      <p className="max-w-md text-sm leading-relaxed text-ink-500">{t.common.notFoundBody}</p>
      <Link href={clinic ? `/c/${clinic}` : "/"} className={buttonClass()}>
        {t.common.notFoundBack}
      </Link>
    </Root>
  );
}
