"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { PRESETS } from "@/lib/finance-periods";

/** One year of the menu: the whole year (past years only), then its months, newest first. */
export type MenuYear = { year: number; whole: { value: string; label: string } | null; months: { value: string; label: string }[] };

/**
 * Which stretch of time the page is about: this month, this year, all time —
 * or any one month or year, from one menu.
 *
 * Few choices on purpose (Yamen, 2026-11-15: "don't put too many options").
 * The three anybody reaches for daily are a switch; everything else is a
 * native menu, which on a phone opens the system's own picker — the easiest
 * list there is to scroll through years of months on.
 *
 * Both answer the press and the page follows: each period is a fresh set of
 * queries on the server, and a control that waits for them reads as one that
 * ignored the tap.
 */
export function PeriodPicker({ slug, current, menu }: { slug: string; current: string; menu: MenuYear[] }) {
  const { t } = useI18n();
  const F = t.finance;
  const router = useRouter();
  const [pressed, setPressed] = useState<string | null>(null);
  useEffect(() => setPressed(null), [current]);
  const on = pressed ?? current;
  const href = (p: string) => (p === "month" ? `/c/${slug}/analytics` : `/c/${slug}/analytics?p=${p}`);
  const picked = !(PRESETS as readonly string[]).includes(on);

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2" data-period={current}>
      <div role="tablist" aria-label={F.period} className="inline-flex rounded-full bg-ink-900/5 p-0.5">
        {PRESETS.map((key) => (
          <Link
            key={key}
            href={href(key)}
            role="tab"
            aria-selected={on === key}
            onClick={() => setPressed(key)}
            scroll={false}
            className={`touch-manipulation whitespace-nowrap rounded-full px-3.5 py-1.5 text-[0.8125rem] font-semibold transition-colors duration-140 ease-out ${
              on === key ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
            }`}
          >
            {F.presets[key]}
          </Link>
        ))}
      </div>

      {menu.length > 0 && (
        /*
          A real <select> under a drawn pill: the pill is what is seen, the
          select — stretched over it, transparent — is what is tapped. So the
          control looks like the switch beside it and still opens the system's
          own list.
        */
        <label
          className={`relative inline-flex items-center gap-1.5 rounded-full py-1.5 ps-3 pe-2.5 text-[0.8125rem] font-semibold transition-colors duration-140 ease-out ${
            picked ? "bg-brand-600 text-on-brand" : "bg-ink-900/5 text-ink-500 hover:text-ink-700"
          }`}
        >
          <CalendarDays className="h-3.5 w-3.5" aria-hidden />
          <span className="whitespace-nowrap">
            {picked
              ? menu.flatMap((y) => [...(y.whole ? [y.whole] : []), ...y.months]).find((o) => o.value === on)?.label ?? F.pick
              : F.pick}
          </span>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          <select
            aria-label={F.pick}
            value={picked ? on : ""}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              setPressed(v);
              router.push(href(v), { scroll: false });
            }}
            className="absolute inset-0 cursor-pointer appearance-none opacity-0"
            data-period-pick
          >
            <option value="" disabled>
              {F.pick}
            </option>
            {menu.map((y) => (
              <optgroup key={y.year} label={String(y.year)}>
                {y.whole && <option value={y.whole.value}>{y.whole.label}</option>}
                {y.months.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
