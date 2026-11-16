"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";

type List = "invoices" | "payments";

/**
 * Invoices or payments: the two lists of one tab.
 *
 * They were two tabs of the Finance strip until 2026-11-15. A segmented
 * control and not a second strip of tabs, which is what stood here before
 * that and read as two rows of the same navigation.
 *
 * The choice is held here and answers the press; the URL (`?tab=payments`,
 * where the payments list has always been) follows when the server has the
 * other list ready.
 */
export function ListSwitch({ slug }: { slug: string }) {
  const { t } = useI18n();
  const params = useSearchParams();
  const shown: List = params.get("tab") === "payments" ? "payments" : "invoices";
  const [pressed, setPressed] = useState<List | null>(null);
  useEffect(() => setPressed(null), [shown]);
  const current = pressed ?? shown;

  const base = `/c/${slug}/invoices`;
  const options: [List, string, string][] = [
    ["invoices", t.invoices.title, base],
    ["payments", t.invoices.payments, `${base}?tab=payments`],
  ];

  return (
    <div role="tablist" aria-label={t.invoices.tabTitle} className="inline-flex shrink-0 rounded-full bg-ink-900/5 p-0.5" data-list-switch>
      {options.map(([key, label, href]) => (
        <Link
          key={key}
          href={href}
          role="tab"
          aria-selected={current === key}
          onClick={() => setPressed(key)}
          scroll={false}
          className={`touch-manipulation rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors duration-140 ease-out ${
            current === key ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
          }`}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
