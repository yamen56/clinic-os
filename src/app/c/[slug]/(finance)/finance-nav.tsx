"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { LinkTabs } from "@/components/ui/misc";
import { useI18n } from "@/lib/i18n/client";
import { financeHref, type FinanceTab } from "@/lib/finance";

/**
 * The strip across the top of the money section.
 *
 * Payments is a tab here and not a route: it is the invoices screen's other
 * list, reached by `?tab=payments`, which is why this reads the query string as
 * well as the path. That also means it cannot be a server component — a layout
 * is never handed `searchParams`.
 */
export function FinanceNav({ slug, tabs }: { slug: string; tabs: FinanceTab[] }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const params = useSearchParams();

  /*
    Highlight on press rather than on arrival. Every tab here is a server
    component with its own queries, so `usePathname` does not change until that
    work is done — which on a cold month of invoices is long enough to read as
    a tab that ignored the click. The same trick, and the same reason, as
    `settings-nav.tsx`.
  */
  const [pressed, setPressed] = useState<FinanceTab | null>(null);
  const here = `${pathname}${params.get("tab") === "payments" ? "?tab=payments" : ""}`;
  useEffect(() => setPressed(null), [here]);

  const current: FinanceTab =
    pressed ??
    (pathname.includes("/earnings")
      ? "earnings"
      : pathname.includes("/expenses")
        ? "expenses"
        : params.get("tab") === "payments"
          ? "payments"
          : "invoices");

  const label: Record<FinanceTab, string> = {
    invoices: t.nav.invoices,
    payments: t.invoices.payments,
    earnings: t.nav.earnings,
    expenses: t.nav.expenses,
  };

  return (
    <LinkTabs
      onSelect={(k) => setPressed(k as FinanceTab)}
      tabs={tabs.map((tab) => ({
        key: tab,
        href: financeHref(slug, tab),
        label: label[tab],
        active: current === tab,
      }))}
    />
  );
}
