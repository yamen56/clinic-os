"use client";

/*
  Face treatment prices, by kind of work: the price of one — one area, one
  syringe, one thread, one session — typed once, here. Saved as typed when the
  box is left; an empty box means no price yet.
*/

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { FACE_TREATMENTS, FAMILIES, FAMILY_COLOR } from "@/lib/charts/face/catalog";
import type { FacePrice } from "@/lib/charts/face/db";
import { PriceBox } from "../prices/dental-prices";
import { saveFacePriceAction } from "./actions";

export function FacePrices({
  slug,
  currency,
  prices: initial,
  usage,
}: {
  slug: string;
  currency: string;
  prices: FacePrice[];
  usage: Record<string, { used: number; unpriced: number }>;
}) {
  const { t, locale } = useI18n();
  const P = t.services.facePrices;
  const { toast } = useToast();
  const [prices, setPrices] = useState<FacePrice[]>(initial);
  const [waiting, setWaiting] = useState(usage);

  const save = async (key: string, price: number | null) => {
    const r = await saveFacePriceAction(slug, { key, price });
    if (r.error) {
      toast(P.failed, "error");
      return false;
    }
    setPrices((prev) => [...prev.filter((p) => p.chartKey !== key), ...(r.row ? [r.row] : [])]);
    if (r.priced) setWaiting((w) => ({ ...w, [key]: { used: w[key]?.used ?? 0, unpriced: 0 } }));
    toast(price === null ? P.cleared : r.priced ? P.priced.replace("{n}", String(r.priced)) : P.saved);
    return true;
  };

  return (
    <div className="grid gap-4" data-face-prices>
      <div>
        <h2 className="text-[17px] font-semibold">{P.title}</h2>
        <p className="mt-1 max-w-3xl text-[13px] text-ink-500">{P.sub}</p>
      </div>
      {FAMILIES.map((f) => {
        const list = FACE_TREATMENTS.filter((x) => x.family === f);
        if (!list.length) return null;
        return (
          <Card key={f} className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_COLOR[f] }} aria-hidden />
              <h3 className="text-[14px] font-semibold">{P.families[f]}</h3>
            </div>
            <ul className="divide-y divide-line">
              {list.map((x) => {
                const price = prices.find((p) => p.chartKey === x.key) ?? null;
                const u = waiting[x.key];
                return (
                  <li key={x.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5" data-face-price-row={x.key}>
                    <div className="min-w-0 flex-[1_1_14rem]">
                      <div className="text-[13.5px] font-semibold" dir="ltr">
                        {x.en} <span className="font-normal text-ink-500">· {x.ar}</span>
                      </div>
                      {u && (
                        <div className="text-[12px] text-ink-500 tnum">
                          {P.used.replace("{n}", String(u.used))}
                          {u.unpriced > 0 && <span className="text-danger"> · {P.unpriced.replace("{n}", String(u.unpriced))}</span>}
                        </div>
                      )}
                    </div>
                    <span className="text-[12.5px] text-ink-500">{P.pricedBy[x.pricedBy]}</span>
                    <span className="flex items-center gap-1.5">
                      <PriceBox
                        value={price?.price ?? null}
                        placeholder={P.noPrice}
                        label={`${P.price} — ${locale === "ar" ? x.ar : x.en}`}
                        hook={x.key}
                        onSave={(v) => save(x.key, v)}
                      />
                      <span className="text-[12.5px] text-ink-500">{currency}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
