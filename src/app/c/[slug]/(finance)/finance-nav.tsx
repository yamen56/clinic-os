"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LinkTabs } from "@/components/ui/misc";
import { useI18n } from "@/lib/i18n/client";
import { financeHref, type FinanceTab } from "@/lib/finance";

/**
 * The strip across the top of the money section.
 *
 * Invoices and payments are one tab (Yamen, 2026-11-15): the desk raises an
 * invoice and takes its payment in the same breath, and two tabs made that two
 * places. The switch between the two lists is on the screen itself
 * (`list-switch.tsx`), so the strip only reads the path.
 */
export function FinanceNav({ slug, tabs }: { slug: string; tabs: FinanceTab[] }) {
  const { t } = useI18n();
  const pathname = usePathname();

  /*
    Highlight on press rather than on arrival. Every tab here is a server
    component with its own queries, so `usePathname` does not change until that
    work is done — which on a cold month of invoices is long enough to read as
    a tab that ignored the click. The same trick, and the same reason, as
    `settings-nav.tsx`.
  */
  const [pressed, setPressed] = useState<FinanceTab | null>(null);
  useEffect(() => setPressed(null), [pathname]);

  const current: FinanceTab =
    pressed ??
    (pathname.includes("/analytics")
      ? "analytics"
      : pathname.includes("/claims")
        ? "claims"
        : pathname.includes("/earnings")
          ? "earnings"
          : pathname.includes("/expenses")
            ? "expenses"
            : "invoices");

  const label: Record<FinanceTab, string> = {
    invoices: t.invoices.tabTitle,
    analytics: t.finance.tab,
    claims: t.claims.tab,
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
