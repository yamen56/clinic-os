import Link from "next/link";
import { ChevronRight, Package } from "lucide-react";
import { fmtDateOnly } from "@/lib/dates";
import { productAmount } from "@/lib/charts/face/catalog";
import type { StockAttention } from "@/lib/charts/face/stock";
import type { Dict } from "@/lib/i18n/en";

/** Items named under the line before the rest are left to the Stock page. */
const SHOWN = 3;

/**
 * What on the shelf needs somebody, as a part of "Needs you" for whoever keeps
 * Stock: one line that opens the Stock page, and the first few items under it
 * by name, so "Botox — none left" is read without a click. Not there at all
 * when nothing needs attention.
 */
export function StockLines({ slug, items, t, locale }: { slug: string; items: StockAttention[]; t: Dict; locale: string }) {
  if (!items.length) return null;
  const S = t.stock;
  const say = (a: StockAttention) => {
    if (a.kind === "out") return S.out;
    if (a.kind === "low") return `${S.low} · ${productAmount(a.unit, a.amount, locale)}`;
    if (a.kind === "expired") return `${S.expired} · ${productAmount(a.unit, a.amount, locale)}`;
    return t.dashboard.stockExpires.replace("{date}", fmtDateOnly(a.expiresOn!, locale));
  };
  return (
    <div data-stock-card className="border-t border-line">
      <Link
        href={`/c/${slug}/stock`}
        className="flex min-h-11 items-center gap-3 px-5 py-2 text-[0.8125rem] transition-colors duration-140 ease-out hover:bg-ink-900/4"
      >
        <Package className="h-4 w-4 shrink-0 text-ink-400" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 font-medium text-ink-900">{t.dashboard.stock}</span>
        <span className="rounded-full bg-st-pending-soft px-2 py-0.5 text-[0.75rem] font-semibold text-st-pending tnum">{items.length}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
      </Link>
      <ul className="-mt-1 grid gap-1 pb-3 pe-5 ps-12">
        {items.slice(0, SHOWN).map((a) => (
          <li key={a.episode} className="flex min-w-0 items-baseline gap-2 text-[0.75rem]" data-stock-card-item={a.kind}>
            <span dir="auto" className="min-w-0 truncate text-ink-700">
              {a.name}
              {a.lot && <bdi className="ms-1.5 text-ink-400">{a.lot}</bdi>}
            </span>
            <span className={`shrink-0 ${a.kind === "out" || a.kind === "expired" ? "font-semibold text-danger" : "text-ink-500"}`}>{say(a)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
