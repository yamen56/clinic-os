"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { PERIODS, type PeriodKey } from "@/lib/finance-periods";

/**
 * Which stretch of time the page is about.
 *
 * One row above everything it governs, and every figure below follows it —
 * except what is owed, which is a fact about today and says so.
 *
 * The chip lights on the press and the page follows: each period is a fresh
 * set of queries on the server, and a chip that waits for them reads as one
 * that ignored the tap.
 */
export function PeriodPicker({ slug, current }: { slug: string; current: PeriodKey }) {
  const { t } = useI18n();
  const [pressed, setPressed] = useState<PeriodKey | null>(null);
  useEffect(() => setPressed(null), [current]);
  const on = pressed ?? current;

  return (
    <div className="mb-5 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label={t.finance.period} data-period={current}>
      {PERIODS.map((key) => (
        <Link
          key={key}
          href={key === "month" ? `/c/${slug}/analytics` : `/c/${slug}/analytics?p=${key}`}
          role="tab"
          aria-selected={on === key}
          onClick={() => setPressed(key)}
          scroll={false}
          className={`shrink-0 touch-manipulation whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-140 ease-out ${
            on === key ? "bg-brand-600 text-on-brand" : "bg-ink-900/4 text-ink-500 hover:bg-ink-900/8 hover:text-ink-700"
          }`}
        >
          {t.finance.periods[key]}
        </Link>
      ))}
    </div>
  );
}
