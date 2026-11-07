import Link from "next/link";
import { Package } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { fmtDateOnly } from "@/lib/dates";
import { productAmount } from "@/lib/charts/face/catalog";
import type { StockAttention } from "@/lib/charts/face/stock";
import type { Dict } from "@/lib/i18n/en";

/** Rows on the card before the rest are left to the Stock page. */
const SHOWN = 5;

/**
 * What on the shelf needs somebody, on the dashboard of whoever keeps Stock.
 *
 * A card under To do rather than a tile: the tiles are the day's numbers, and a
 * fifth one pushes Outstanding off a phone (DECISIONS #81). It is not there at
 * all when nothing needs attention.
 */
export function StockCard({ slug, items, t, locale }: { slug: string; items: StockAttention[]; t: Dict; locale: string }) {
  if (!items.length) return null;
  const S = t.stock;
  const say = (a: StockAttention) => {
    if (a.kind === "out") return S.out;
    if (a.kind === "low") return `${S.low} · ${productAmount(a.unit, a.amount, locale)}`;
    if (a.kind === "expired") return `${S.expired} · ${productAmount(a.unit, a.amount, locale)}`;
    return t.dashboard.stockExpires.replace("{date}", fmtDateOnly(a.expiresOn!, locale));
  };
  return (
    <div data-stock-card>
      <Card>
        <CardHeader
          title={`${t.dashboard.stock} · ${items.length}`}
          action={
            <Link href={`/c/${slug}/stock`} className="text-[13px] font-semibold text-brand-700 hover:underline">
              {t.dashboard.stockOpen}
            </Link>
          }
        />
        <ul className="divide-y divide-line">
          {items.slice(0, SHOWN).map((a) => (
            <li key={a.episode} className="flex items-start gap-3 px-5 py-3" data-stock-card-item={a.kind}>
              <Package className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
              <div className="min-w-0 flex-1">
                <div dir="auto" className="text-sm font-medium">
                  {a.name}
                  {a.lot && <bdi className="ms-2 text-[12.5px] font-normal text-ink-500">{a.lot}</bdi>}
                </div>
                <div className={`text-[12.5px] ${a.kind === "out" || a.kind === "expired" ? "font-semibold text-danger" : "text-ink-500"}`}>{say(a)}</div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
