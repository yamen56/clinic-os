"use client";

/*
  Face treatment prices, by kind of work: the price of one — one area, one
  syringe, one thread, one session — typed once, here. Under a treatment, the
  products used in it: a product's own price, when it costs the patient more
  or less than the treatment's, else the treatment's. Saved as typed when the
  box is left; an empty box means no price.

  A treatment the clinic does that is not listed is added here as well as at the
  chair (Yamen, 2026-11-08), and is shown at once, waiting for its price.

  Each treatment's colour on the face is chosen here, and a treatment the clinic
  does not do is deleted here, with Undo (0098). Deleted ones wait at the bottom
  to be brought back; their past entries keep their names.
*/

import { useMemo, useState } from "react";
import { Plus, Trash2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AddTreatment } from "@/components/charts/face/add-treatment";
import { FAMILIES, TREATMENT_COLORS, mergeCatalog, treatmentColor, type FaceTreatment, type FaceVariant, type TreatmentLook } from "@/lib/charts/face/catalog";
import { treatmentsCall } from "@/components/charts/face/add-treatment";
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
  stockHref,
  custom: initialCustom,
  variants: initialVariants,
  looks: initialLooks = [],
}: {
  slug: string;
  currency: string;
  prices: FacePrice[];
  products: Product[];
  usage: Record<string, { used: number; unpriced: number }>;
  stockHref: string | null;
  /** The clinic's own treatments and every treatment's kinds (0094). */
  custom: FaceTreatment[];
  variants: FaceVariant[];
  looks?: TreatmentLook[];
}) {
  const [custom, setCustom] = useState(initialCustom);
  const [variants, setVariants] = useState(initialVariants);
  const [adding, setAdding] = useState(false);
  const [looks, setLooks] = useState<TreatmentLook[]>(initialLooks);
  const [painting, setPainting] = useState<string | null>(null);
  const catalog = useMemo(() => mergeCatalog(custom, looks), [custom, looks]);
  const offered = catalog.offered;
  const removedList = useMemo(() => [...catalog.byKey.values()].filter((t) => t.archived), [catalog]);

  // Colour and delete answer the tap at once; the server's lists follow.
  const changeLook = async (body: Record<string, unknown>, optimistic: (l: TreatmentLook[], c: FaceTreatment[]) => [TreatmentLook[], FaceTreatment[]]) => {
    const before = { looks, custom };
    const [nl, nc] = optimistic(looks, custom);
    setLooks(nl);
    setCustom(nc);
    const r = await treatmentsCall(slug, body);
    if (r.error) {
      setLooks(before.looks);
      setCustom(before.custom);
      toast(t.common.genericError, "error");
      return false;
    }
    setLooks(r.looks ?? []);
    setCustom(r.custom);
    setVariants(r.variants);
    return true;
  };
  const upsert = (l: TreatmentLook[], key: string, change: Partial<TreatmentLook>) => {
    const had = l.find((x) => x.key === key);
    return had ? l.map((x) => (x.key === key ? { ...x, ...change } : x)) : [...l, { key, color: null, removed: false, ...change }];
  };
  const paint = (x: FaceTreatment, color: string | null) => {
    setPainting(null);
    void changeLook({ op: "color", key: x.key, color }, (l, c) => [upsert(l, x.key, { color }), c]);
  };
  const remove = (x: FaceTreatment, removed: boolean) => {
    void changeLook({ op: "remove", key: x.key, removed }, (l, c) =>
      x.custom ? [l, c.map((y) => (y.key === x.key ? { ...y, archived: removed } : y))] : [upsert(l, x.key, { removed }), c]
    ).then((ok) => {
      if (ok && removed) toast(P.removed.replace("{name}", x.en), "success", { label: P.undo, onClick: () => remove(x, false) });
    });
  };
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
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button size="sm" variant="outline" className="min-h-10" onClick={() => setAdding(true)} data-face-prices-add>
            <Plus className="h-4 w-4" />
            {P.addTreatment}
          </Button>
          {stockHref && (
            <Link href={stockHref} className="text-[13px] font-semibold text-brand-700 hover:underline" data-face-prices-stock>
              {P.stockLink}
            </Link>
          )}
        </div>
      </div>
      {adding && (
        <AddTreatment
          slug={slug}
          zones={[]}
          onClose={() => setAdding(false)}
          onAdded={(key, nextCustom, nextVariants, nextLooks) => {
            setCustom(nextCustom);
            setVariants(nextVariants);
            if (nextLooks) setLooks(nextLooks);
            setAdding(false);
            const made = nextCustom.find((c) => c.key === key);
            toast(P.added.replace("{name}", made?.en ?? ""));
            // Straight to its price box: a new treatment's next step.
            requestAnimationFrame(() => {
              const box = document.querySelector<HTMLInputElement>(`[data-price-box="${key}"]`);
              box?.scrollIntoView({ block: "center", behavior: "smooth" });
              box?.focus({ preventScroll: true });
            });
          }}
        />
      )}
      {FAMILIES.map((f) => {
        const list = offered.filter((x) => x.family === f);
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
                      <div className="flex min-w-0 flex-[1_1_14rem] items-start gap-2.5">
                        {/* Its colour on the face: tap, pick. */}
                        <span className="relative shrink-0">
                          <button
                            type="button"
                            onClick={() => setPainting((p) => (p === x.key ? null : x.key))}
                            aria-label={P.color.replace("{name}", x.en)}
                            aria-expanded={painting === x.key}
                            className="mt-0.5 grid h-8 w-8 place-items-center rounded-full border border-line hover:bg-sunken"
                            data-face-color={x.key}
                          >
                            <span className="h-4 w-4 rounded-full" style={{ background: treatmentColor(x, x.family) }} />
                          </button>
                          {painting === x.key && (
                            <span className="absolute start-0 top-9 z-20 grid w-[13.5rem] grid-cols-6 gap-1.5 rounded-card border border-line bg-surface p-2.5 shadow-pop" data-face-palette={x.key}>
                              {TREATMENT_COLORS.map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => paint(x, c)}
                                  aria-label={c}
                                  aria-pressed={x.color === c}
                                  className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-surface ${x.color === c ? "ring-2 ring-ink-900" : ""}`}
                                  style={{ background: c }}
                                  data-face-swatch={c}
                                />
                              ))}
                              <button type="button" onClick={() => paint(x, null)} className="col-span-6 mt-1 min-h-8 rounded-ctl text-[12.5px] font-semibold text-brand-700 hover:bg-sunken" data-face-swatch-reset>
                                {P.familyColor}
                              </button>
                            </span>
                          )}
                        </span>
                        <div className="min-w-0">
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
                      <button
                        type="button"
                        onClick={() => remove(x, true)}
                        aria-label={P.remove.replace("{name}", x.en)}
                        title={P.remove.replace("{name}", x.en)}
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-danger-soft hover:text-danger"
                        data-face-remove={x.key}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {variants.some((v) => v.treatmentKey === x.key && v.active) && (
                      <ul className="mt-2 grid gap-1.5 border-s-2 border-line ps-3">
                        {variants
                          .filter((v) => v.treatmentKey === x.key && v.active)
                          .map((v) => {
                            const mine = priceOf(x.key, v.id);
                            return (
                              <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-face-variant-price={`${x.key}:${v.name}`}>
                                <span className="min-w-0 flex-[1_1_12rem] text-[13px]" dir="auto">
                                  {P.kind.replace("{kind}", locale === "ar" ? v.nameAr || v.name : v.name)}
                                </span>
                                <span className="flex items-center gap-1.5">
                                  <PriceBox
                                    value={mine?.price ?? null}
                                    placeholder={base ? String(base.price) : P.noPrice}
                                    label={`${P.price} — ${v.name}`}
                                    hook={`${x.key}:${v.id}`}
                                    onSave={(val) => save(x.key, v.id, val)}
                                  />
                                  <span className="text-[12.5px] text-ink-500">{currency}</span>
                                </span>
                              </li>
                            );
                          })}
                      </ul>
                    )}
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
      {removedList.length > 0 && (
        <Card className="overflow-hidden" data-face-removed={removedList.length}>
          <div className="border-b border-line px-4 py-2.5">
            <div className="text-[13.5px] font-semibold">{P.removedTitle}</div>
            <div className="text-[12px] text-ink-500">{P.removedHint}</div>
          </div>
          <ul className="divide-y divide-line">
            {removedList.map((x) => (
              <li key={x.key} className="flex items-center gap-3 px-4 py-2" data-face-removed-row={x.key}>
                <span className="h-3 w-3 shrink-0 rounded-full opacity-60" style={{ background: treatmentColor(x, x.family) }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-700" dir="ltr">
                  {x.en} <span className="text-ink-500">· {x.ar}</span>
                </span>
                <Button size="sm" variant="outline" className="min-h-9" onClick={() => remove(x, false)} data-face-bring-back={x.key}>
                  <RotateCcw className="h-4 w-4" />
                  {P.bringBack}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
