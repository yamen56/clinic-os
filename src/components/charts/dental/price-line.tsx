"use client";

/*
  A treatment's price, where the treatment is: in its card and in its entry.

  The price comes from the clinic's list and is never typed here (Yamen,
  2026-10-12): adding a treatment brings its price with it, so the reception
  can bill it. What can be chosen is how this patient pays for it — the whole
  treatment, or each visit — when the list has both prices; the doctor at the
  chair or the reception at the desk chooses, until any of it is billed. For
  whoever bills, it also says whether it is billed yet.
*/

import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { fmtMoney } from "@/lib/dates";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { pickPrice, variantOf, type PriceUnit } from "@/lib/charts/dental/pricing";
import { useDentalStore, type DentalStore } from "./store";
import { useChartWriter } from "./writer";
import { moneyOf, type Money } from "./money";
import { INK, SOFT } from "./tooth-art";

/** A treatment that carries a price: work done to the patient, not what they came with — and not a tooth of a full arch, priced as the arch. */
export function priceable(m: Mark, marks: Mark[]): boolean {
  if (m.kind !== "procedure" || m.status === "existing" || m.voidedAt) return false;
  return !(m.groupId && isToothSite(m.site) && marks.some((x) => x.groupId === m.groupId && !isToothSite(x.site)));
}

export function cashOf(m: Mark, store: DentalStore, tz: string): Money {
  return moneyOf(m, { marks: store.marks, steps: store.steps, prices: store.prices, billing: store.billing, billingSince: store.billingSince, tz });
}

/** "120 JOD", "30 JOD a visit", "30 JOD a visit · 2 visits = 60 JOD", "90 JOD × 3 = 270 JOD" (a bridge's teeth) — null when unpriced. */
export function priceText(cash: Money, currency: string, locale: string, P: { eachVisit: string; visits: string }): string | null {
  if (cash.fee == null) return null;
  const fmt = (n: number) => fmtMoney(n, currency, locale);
  if (cash.unit === "session") {
    const each = P.eachVisit.replace("{fee}", fmt(cash.fee));
    return cash.units > 1 && cash.amount != null ? `${each} · ${P.visits.replace("{n}", String(cash.units))} = ${fmt(cash.amount)}` : each;
  }
  return cash.units > 1 && cash.amount != null ? `${fmt(cash.fee)} × ${cash.units} = ${fmt(cash.amount)}` : fmt(cash.fee);
}

/** The short form an entry shows in its line: the price and, for whoever bills, whether it is billed. */
export function useEntryMoney(tz: string): (m: Mark) => string | undefined {
  const { t, locale } = useI18n();
  const P = t.dental.price;
  const store = useDentalStore();
  return (m: Mark) => {
    if (!priceable(m, store.marks)) return undefined;
    const cash = cashOf(m, store, tz);
    const parts = [
      priceText(cash, store.currency, locale, P) ?? P.none,
      store.canBill ? (cash.billed ? P.billed : cash.toBill ? P.notBilled : null) : null,
    ].filter(Boolean);
    return parts.join(" · ");
  };
}

export function PriceLine({ m, tz }: { m: Mark; tz: string }) {
  const { t, locale } = useI18n();
  const P = t.dental.price;
  const store = useDentalStore();
  const w = useChartWriter();
  if (!priceable(m, store.marks)) return null;
  const cash = cashOf(m, store, tz);
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  const variant = variantOf(m.treatmentKey, m.detail);
  const whole = pickPrice(store.prices, m.treatmentKey, variant, "item");
  const visit = pickPrice(store.prices, m.treatmentKey, variant, "session");
  // Chosen by the doctor or the desk, until any of it is on an invoice.
  const mayChoose = (store.canWrite || store.canBill) && !cash.billed;
  const text = priceText(cash, store.currency, locale, P);
  const choice = (unit: PriceUnit, label: string, amount: string) => {
    const on = m.fee != null && cash.unit === unit;
    return (
      <button
        key={unit}
        type="button"
        role="radio"
        aria-checked={on}
        disabled={!mayChoose || on}
        onClick={() => void w.chargeBy(m, unit)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[12.5px] font-semibold transition-colors duration-140 disabled:cursor-default ${
          on ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-800"
        }`}
        data-charge={unit}
      >
        {label}
        <span className="font-medium tnum text-ink-500">{amount}</span>
      </button>
    );
  };

  return (
    <div className="grid gap-1.5" data-price-line={m.id} data-unit={m.fee == null ? "" : cash.unit} data-amount={cash.amount ?? ""}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="text-[12px] font-semibold text-ink-500">{P.label}</span>
        <span className={`font-semibold tnum ${text ? "text-ink-900" : "text-ink-500"}`}>{text ?? P.none}</span>
        {!text && store.canPrice && (
          <Link href={`/c/${store.slug}/settings/prices`} className="text-[12px] font-semibold text-brand-700 hover:underline">
            {P.setPrices}
          </Link>
        )}
        {store.canBill && text && (
          <span
            className="ms-auto rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
            style={cash.billed ? { background: SOFT.done, color: INK.done } : { background: "var(--color-sunken)", color: "var(--color-ink-500)" }}
            data-billed={cash.billed ? "yes" : "no"}
          >
            {cash.billed ? `${P.billed} · ${cash.invoices.map((i) => i.number).join(", ")}` : P.notBilled}
          </span>
        )}
      </div>
      {/* The list prices it both ways: this patient pays one of them. */}
      {whole && visit && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-500">{P.chargeBy}</span>
          <div className="inline-flex rounded-ctl bg-sunken p-0.5" role="radiogroup" aria-label={P.chargeBy} data-charge-by={m.fee == null ? "" : cash.unit}>
            {choice("item", P.whole, fmt(whole.price))}
            {choice("session", P.perVisit, P.eachVisit.replace("{fee}", fmt(visit.price)))}
          </div>
        </div>
      )}
    </div>
  );
}
