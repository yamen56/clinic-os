"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { LoaderCircle } from "lucide-react";
import { SearchInput } from "@/components/ui/input";

/*
  Finding one invoice among hundreds.

  The list shows the newest hundred, so an invoice from March could only be
  reached through the patient's file — reception had to know whose it was
  before they could find it. The box searches the way the patients screen
  does (Arabic spellings folded, any phone format, file number) and adds the
  invoice's own number and title.

  The text is held here, so typing is never waiting on the server; the URL
  follows a quarter-second behind and the server renders the matches. The
  filter chips keep the search, because "unpaid, for Khaled" is one question.
*/
export function InvoiceSearch({ initial }: { initial: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(initial);
  const [pending, start] = useTransition();

  useEffect(() => {
    /*
      Only when the words differ from what the URL already searches. A
      "skip the first run" flag is not enough: Strict Mode runs the effect
      twice on mount, and the second run sent a navigation to the same address
      a quarter-second after every page load.
    */
    const v = q.trim();
    if (v === (params.get("q") ?? "")) return;
    const id = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (v) next.set("q", v);
      else next.delete("q");
      // A new search starts again from the newest page.
      next.delete("n");
      const s = next.toString();
      start(() => router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false }));
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the text drives a search
  }, [q]);

  return (
    <div className="relative w-full sm:w-72" data-invoice-search>
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.invoices.searchPlaceholder} aria-label={t.common.search} />
      {pending && <LoaderCircle className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-400" />}
    </div>
  );
}
