"use client";

/*
  Dental prices: what each treatment on the chart costs.

  The dentist said each treatment has its price — each kind of crown its own —
  and that the doctor sets them. They are set here, once, and every treatment
  planned on a patient's chart starts at this price (the doctor can still
  change it for one patient). A price is a service: the invoice builder, the
  booking page and the chart read the same list, so the same cleaning never
  costs two different amounts. A treatment the clinic already sells as a
  service is linked to it rather than priced twice.

  Saved as typed, when the box is left. An empty box means no price yet: the
  treatment is charted without one, and the desk prices it on the invoice.
*/

import { useMemo, useState } from "react";
import { ChevronDown, Link2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/input";
import { BUILT_IN, PROCEDURE_CATEGORIES, matchesQuery, type Treatment } from "@/lib/charts/dental/catalog";
import { PER_SESSION_BY_DEFAULT, PRICE_BY, type PriceRow } from "@/lib/charts/dental/pricing";
import { saveDentalPriceAction } from "./actions";

export type DentalPrice = PriceRow;
export type LinkableService = { id: string; name: string; name_ar: string | null; price: string };

/** A price box: the figure as typed, saved when it is left. */
function PriceBox({ value, placeholder, label, onSave }: { value: number | null; placeholder?: string; label: string; onSave: (v: number | null) => Promise<boolean> }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const commit = async () => {
    const v = text.trim() === "" ? null : Number(text);
    if (v !== null && (!Number.isFinite(v) || v < 0)) return;
    if (v === value) return;
    setSaving(true);
    const ok = await onSave(v);
    setSaving(false);
    if (!ok) setText(value == null ? "" : String(value));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      dir="ltr"
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => /^\d{0,7}(\.\d{0,3})?$/.test(e.target.value) && setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`h-9 w-24 rounded-ctl border bg-surface px-2 text-end text-base tnum focus:border-brand-600 focus:outline-none md:text-sm ${saving ? "border-brand-300" : "border-line"}`}
      data-price-box={label}
    />
  );
}

export function DentalPrices({
  slug,
  currency,
  custom,
  prices: initial,
  services,
}: {
  slug: string;
  currency: string;
  /** The clinic's own treatments, as the chart knows them. */
  custom: Treatment[];
  prices: DentalPrice[];
  /** The clinic's services not yet linked to a treatment: what a treatment can be "the same as". */
  services: LinkableService[];
}) {
  const { t, locale } = useI18n();
  const S = t.services.dental;
  const { toast } = useToast();
  const [prices, setPrices] = useState<DentalPrice[]>(initial);
  const [free, setFree] = useState<LinkableService[]>(services);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(["endodontic", "fixed", "implant", "preventive", "restorative"]));

  const treatments = useMemo(() => [...BUILT_IN, ...custom].filter((tr) => tr.kind === "procedure"), [custom]);
  const priceOf = (key: string, variant: string | null) => prices.find((p) => p.chartKey === key && p.variant === variant) ?? null;
  const unitOf = (key: string) => priceOf(key, null)?.unit ?? prices.find((p) => p.chartKey === key)?.unit ?? (PER_SESSION_BY_DEFAULT.has(key) ? "session" : "item");

  const save = async (key: string, variant: string | null, price: number | null, unit: "item" | "session", link?: string): Promise<boolean> => {
    const r = await saveDentalPriceAction(slug, { key, variant, price, unit, linkServiceId: link ?? null });
    if (r.error) {
      toast(S.failed, "error");
      return false;
    }
    setPrices((prev) => [...prev.filter((p) => !(p.chartKey === key && p.variant === variant)), ...(r.row ? [r.row] : [])]);
    if (link) setFree((prev) => prev.filter((s) => s.id !== link));
    if (r.released) setFree((prev) => [...prev, r.released!]);
    return true;
  };

  const groups = PROCEDURE_CATEGORIES.map((cat) => ({ cat, list: treatments.filter((tr) => tr.category === cat && matchesQuery(tr, q)) })).filter((g) => g.list.length);
  const priced = new Set(prices.map((p) => p.chartKey)).size;

  return (
    // The hook sits on a wrapper: Card passes on no data-* attribute.
    <div data-dental-prices>
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">{S.title}</h2>
            <p className="mt-1 max-w-2xl text-[13px] text-ink-500">{S.sub}</p>
          </div>
          <span className="rounded-full bg-sunken px-2.5 py-1 text-[12px] font-semibold text-ink-500 tnum">{S.count.replace("{n}", String(priced))}</span>
        </div>
        <SearchInput className="mb-4 w-full sm:w-80" placeholder={S.search} value={q} onChange={(e) => setQ(e.target.value)} />

        <div className="grid gap-2">
          {groups.map(({ cat, list }) => {
            const isOpen = open.has(cat) || !!q;
            return (
              <section key={cat} className="rounded-card border border-line" data-price-group={cat}>
                <button
                  type="button"
                  onClick={() => setOpen((prev) => {
                    const n = new Set(prev);
                    if (n.has(cat)) n.delete(cat);
                    else n.add(cat);
                    return n;
                  })}
                  className="flex w-full items-center justify-between gap-2 px-4 py-3 text-start"
                >
                  <span className="text-[14px] font-semibold">{t.dental.categories[cat]}</span>
                  <ChevronDown className={`h-4 w-4 text-ink-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
                {isOpen && (
                  <ul className="divide-y divide-line border-t border-line">
                    {list.map((tr) => {
                      const base = priceOf(tr.key, null);
                      const unit = unitOf(tr.key);
                      const field = PRICE_BY[tr.key] ? tr.details?.find((d) => d.key === PRICE_BY[tr.key]) : undefined;
                      const name = locale === "ar" ? tr.ar : tr.en;
                      const sub = locale === "ar" ? tr.en : tr.abbr;
                      return (
                        <li key={tr.key} className="grid gap-2 px-4 py-3" data-price-row={tr.key}>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <div className="min-w-[12rem] flex-1">
                              <div className="text-[14px] font-medium">{name}</div>
                              {sub && <div className="text-[12px] text-ink-500" dir="ltr">{sub}</div>}
                            </div>
                            <PriceBox value={base?.price ?? null} label={name} onSave={(v) => save(tr.key, null, v, unit)} />
                            <span className="text-[12px] text-ink-500">{currency}</span>
                            <select
                              value={unit}
                              onChange={(e) => {
                                const u = e.target.value as "item" | "session";
                                // The unit belongs to the treatment: every price of it moves together.
                                for (const p of prices.filter((x) => x.chartKey === tr.key)) void save(tr.key, p.variant, p.price, u);
                              }}
                              disabled={!prices.some((x) => x.chartKey === tr.key)}
                              className="select-chevron h-9 appearance-none rounded-ctl border border-line bg-surface ps-2.5 pe-8 text-[13px] disabled:opacity-50"
                              aria-label={S.unit}
                              data-price-unit={tr.key}
                            >
                              <option value="item">{S.perItem}</option>
                              <option value="session">{S.perSession}</option>
                            </select>
                            {!base && free.length > 0 && (
                              <label className="flex items-center gap-1.5 text-[12px] text-ink-500">
                                <Link2 className="h-3.5 w-3.5" />
                                <select
                                  value=""
                                  onChange={(e) => e.target.value && void save(tr.key, null, null, unit, e.target.value)}
                                  className="select-chevron h-9 max-w-[12rem] appearance-none rounded-ctl border border-line bg-surface ps-2.5 pe-8 text-[13px]"
                                  aria-label={S.sameAs}
                                  data-same-as={tr.key}
                                >
                                  <option value="">{S.sameAs}</option>
                                  {free.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {(locale === "ar" ? s.name_ar || s.name : s.name) + ` · ${Number(s.price)}`}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </div>
                          {field && (
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ps-0 sm:ps-4">
                              {field.options.map((o) => {
                                const v = priceOf(tr.key, o.key);
                                const label = locale === "ar" ? o.ar : o.en;
                                return (
                                  <label key={o.key} className="flex items-center gap-2 text-[13px]" data-price-variant={`${tr.key}:${o.key}`}>
                                    <span className="text-ink-700">{label}</span>
                                    <PriceBox
                                      value={v?.price ?? null}
                                      placeholder={base ? String(base.price) : "—"}
                                      label={`${name} · ${label}`}
                                      onSave={(p) => save(tr.key, o.key, p, unit)}
                                    />
                                  </label>
                                );
                              })}
                              <span className="text-[12px] text-ink-400">{S.variantHint}</span>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
