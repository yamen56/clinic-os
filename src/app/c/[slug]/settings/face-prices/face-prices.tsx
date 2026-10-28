"use client";

/*
  Face treatment prices, by kind of work: the price of one — one area, one
  syringe, one thread, one session — typed once, here. Under a treatment, the
  products used in it: a product's own price, when it costs the patient more
  or less than the treatment's, else the treatment's. Saved as typed when the
  box is left; an empty box means no price.
*/

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { FACE_TREATMENTS, FAMILIES } from "@/lib/charts/face/catalog";
import type { FacePrice } from "@/lib/charts/face/db";
import { FamilyTag } from "@/components/charts/face/family-tag";
import { PriceBox } from "../prices/dental-prices";
import { saveFacePriceAction } from "./actions";

type Product = { id: string; name: string; company: string | null; treatments: string[] };

export function FacePrices({
  slug,
  currency,
  prices: initial,
  products,
  usage,
}: {
  slug: string;
  currency: string;
  prices: FacePrice[];
  products: Product[];
  usage: Record<string, { used: number; unpriced: number }>;
}) {
  const { t, locale } = useI18n();
  const P = t.services.facePrices;
  const { toast } = useToast();
  const [prices, setPrices] = useState<FacePrice[]>(initial);
  const [waiting, setWaiting] = useState(usage);

  const priceOf = (key: string, productId: string | null) => prices.find((p) => p.chartKey === key && p.variant === productId) ?? null;

  const save = async (key: string, productId: string | null, price: number | null) => {
    const r = await saveFacePriceAction(slug, { key, productId, price });
    if (r.error) {
      toast(P.failed, "error");
      return false;
    }
    setPrices((prev) => [...prev.filter((p) => !(p.chartKey === key && p.variant === productId)), ...(r.row ? [r.row] : [])]);
    if (r.priced) setWaiting((w) => ({ ...w, [key]: { used: w[key]?.used ?? 0, unpriced: Math.max(0, (w[key]?.unpriced ?? 0) - r.priced!) } }));
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
              <FamilyTag family={f} label={P.families[f]} className="h-6 text-[12.5px]" />
            </div>
            <ul className="divide-y divide-line">
              {list.map((x) => {
                const base = priceOf(x.key, null);
                const u = waiting[x.key];
                const own = products.filter((p) => p.treatments.includes(x.key));
                return (
                  <li key={x.key} className="px-4 py-2.5" data-face-price-row={x.key}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
                          value={base?.price ?? null}
                          placeholder={P.noPrice}
                          label={`${P.price} — ${locale === "ar" ? x.ar : x.en}`}
                          hook={x.key}
                          onSave={(v) => save(x.key, null, v)}
                        />
                        <span className="text-[12.5px] text-ink-500">{currency}</span>
                      </span>
                    </div>
                    {own.length > 0 && (
                      <ul className="mt-2 grid gap-1.5 border-s-2 border-line ps-3">
                        {own.map((p) => {
                          const mine = priceOf(x.key, p.id);
                          return (
                            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-face-product-price={`${x.key}:${p.id}`}>
                              <span className="min-w-0 flex-[1_1_12rem] text-[13px]" dir="auto">
                                {P.withProduct.replace("{product}", p.name)}
                                {p.company && <span className="text-ink-500"> · {p.company}</span>}
                              </span>
                              <span className="flex items-center gap-1.5">
                                <PriceBox
                                  value={mine?.price ?? null}
                                  placeholder={base ? String(base.price) : P.noPrice}
                                  label={`${P.price} — ${p.name}`}
                                  hook={`${x.key}:${p.id}`}
                                  onSave={(v) => save(x.key, p.id, v)}
                                />
                                <span className="text-[12.5px] text-ink-500">{currency}</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
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
