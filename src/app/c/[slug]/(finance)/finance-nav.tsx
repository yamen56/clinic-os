"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Banknote, ChartColumn, HandCoins, ReceiptText, ShieldCheck, type LucideIcon } from "lucide-react";
import { LinkTabs } from "@/components/ui/misc";
import { useI18n } from "@/lib/i18n/client";
import { financeHref, type FinanceTab } from "@/lib/finance";

/** Which tab a path belongs to. */
function tabOf(pathname: string): FinanceTab {
  return pathname.includes("/analytics")
    ? "analytics"
    : pathname.includes("/claims")
      ? "claims"
      : pathname.includes("/earnings")
        ? "earnings"
        : pathname.includes("/expenses")
          ? "expenses"
          : "invoices";
}

/**
 * The strip across the top of the money section, and the page under it.
 *
 * A switch between tabs is one step, not two (Yamen, 2026-11-15: "switching
 * between earnings and invoices is not smooth"). There used to be a skeleton
 * between them, drawn once for the whole section — four tiles over a list —
 * which matched no tab after the invoice totals went, so every switch showed
 * one layout and then jumped to another; and when the next tab was quick, the
 * skeleton was skipped, so the same click looked different from one time to
 * the next. Now the tab lights on the press, the page that is there stays and
 * fades back, a slim line runs under the strip, and the next tab replaces it
 * whole. Arriving in Finance from elsewhere still shows the workspace's own
 * skeleton (`c/[slug]/loading.tsx`).
 *
 * Invoices and payments are one tab (2026-11-15); the switch between the two
 * lists is on that screen (`list-switch.tsx`), so the strip reads the path only.
 */
export function FinanceFrame({
  slug,
  tabs,
  children,
}: {
  slug: string;
  tabs: FinanceTab[];
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const here = tabOf(pathname);

  const [pressed, setPressed] = useState<FinanceTab | null>(null);
  useEffect(() => setPressed(null), [pathname]);

  /* On a phone the strip scrolls sideways; LinkTabs keeps the open tab in view
     (Expenses used to show as "E…") and fades the edge that has more. */
  // Pressing the tab already open goes nowhere, so it must not wait for anything.
  const going = pressed !== null && pressed !== here ? pressed : null;
  const current = going ?? here;

  const label: Record<FinanceTab, string> = {
    invoices: t.invoices.tabTitle,
    analytics: t.finance.tab,
    claims: t.claims.tab,
    earnings: t.nav.earnings,
    expenses: t.nav.expenses,
  };
  /*
    An icon each, so a tab is recognised before it is read (Yamen,
    2026-11-16). The same pictures the screens use inside: Banknote is an
    expense paid, ReceiptText an invoice.
  */
  const icon: Record<FinanceTab, LucideIcon> = {
    invoices: ReceiptText,
    claims: ShieldCheck,
    earnings: HandCoins,
    expenses: Banknote,
    analytics: ChartColumn,
  };

  return (
    <>
      <LinkTabs
        onSelect={(k) => setPressed(k as FinanceTab)}
        tabs={tabs.map((tab) => {
          const Icon = icon[tab];
          return {
            key: tab,
            href: financeHref(slug, tab),
            label: (
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {label[tab]}
              </span>
            ),
            active: current === tab,
          };
        })}
      />
      {/*
        The shell already runs its line across the top for any page on its way,
        so this only fades the page that is leaving — after 150ms, so a tab
        that is there at once never flickers.
      */}
      <div
        className={`transition-opacity duration-200 ease-out ${going ? "pointer-events-none opacity-55 delay-150" : "opacity-100 delay-0"}`}
        aria-busy={going ? true : undefined}
        data-finance-body={going ? "pending" : "ready"}
      >
        {children}
      </div>
    </>
  );
}
