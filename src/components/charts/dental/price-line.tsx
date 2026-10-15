"use client";

/*
  A treatment's price, where the treatment is: in its card and in its entry.

  The price comes from the clinic's list: adding a treatment brings its price
  with it, so the reception can bill it. For one patient it can be changed
  (Yamen, 2026-10-15: "it says $100 — for this person I want it to be $120"):
  Edit price sets this patient's, the list stays as it is, and the invoice
  bills what was set. How this patient pays — the whole treatment, or each
  visit — is chosen here too when the list has both prices. The doctor at the
  chair or the reception at the desk may do either, until any of it is
  billed. For whoever bills, it also says whether it is billed yet.
*/

import { useState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
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
  // The list's price for it, charged the way it is: what "Use the list price" goes back to.
  const list = pickPrice(store.prices, m.treatmentKey, variant, m.fee == null ? null : cash.unit);
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
    <div className="grid gap-1.5" data-price-line={m.id} data-unit={m.fee == null ? "" : cash.unit} data-amount={cash.amount ?? ""} data-fee-manual={m.feeManual ? "yes" : "no"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="text-[12px] font-semibold text-ink-500">{P.label}</span>
        <span className={`font-semibold tnum ${text ? "text-ink-900" : "text-ink-500"}`} data-price-text>{text ?? P.none}</span>
        {m.feeManual && (
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11.5px] font-semibold text-brand-700" data-fee-edited>
            {P.edited}
            {list && list.price !== m.fee ? ` · ${P.listWas.replace("{fee}", fmt(list.price))}` : ""}
          </span>
        )}
        {mayChoose && (
          <FeeEditor m={m} unit={m.fee == null ? null : cash.unit} currency={store.currency} label={text ? P.edit : P.setForPatient} onSave={(fee) => w.setFee(m, fee)} />
        )}
        {m.feeManual && mayChoose && (
          <button type="button" onClick={() => void w.setFee(m, null)} className="text-[12px] font-semibold text-ink-500 hover:text-ink-900 hover:underline" data-fee-reset>
            {P.useList}
          </button>
        )}
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

/**
 * This patient's price, typed: a pencil that opens one field, the amount the
 * list gave already in it. Charged per visit, the amount is each visit's.
 */
function FeeEditor({
  m,
  unit,
  currency,
  label,
  onSave,
}: {
  m: Mark;
  unit: PriceUnit | null;
  currency: string;
  label: string;
  onSave: (fee: number) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const P = t.dental.price;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const value = Number(text.replace(",", "."));
  const valid = text.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setText(m.fee == null ? "" : String(m.fee));
          setOpen(true);
        }}
        className="inline-flex h-7 items-center gap-1 rounded-ctl px-1.5 text-[12px] font-semibold text-brand-700 hover:bg-brand-50"
        data-fee-edit={m.id}
      >
        <Pencil className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  }
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const ok = await onSave(Math.round(value * 100) / 100);
    setBusy(false);
    if (ok) setOpen(false);
  };
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2 rounded-ctl bg-canvas p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-fee-form={m.id}
    >
      <label className="flex items-center gap-2 text-[12px] font-semibold text-ink-500">
        {unit === "session" ? P.perVisitField : P.forPatient}
        {/* The focus ring goes round the whole box, the currency with it, not the number alone. */}
        <span className="flex h-9 items-center rounded-ctl border border-line bg-surface focus-within:border-brand-600 focus-within:shadow-[0_0_0_3px_rgb(125_141_164/0.45)]" dir="ltr">
          <input
            autoFocus
            inputMode="decimal"
            value={text}
            onChange={(e) => /^\d{0,7}([.,]\d{0,2})?$/.test(e.target.value) && setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              setOpen(false);
            }}
            aria-label={P.forPatient}
            className="h-full w-24 rounded-ctl bg-transparent px-2 text-base font-semibold text-ink-900 tnum focus:outline-none focus-visible:!shadow-none md:text-sm"
            data-fee-input
          />
          <span className="pe-2 text-[12px] font-semibold text-ink-400">{currency}</span>
        </span>
      </label>
      <div className="ms-auto flex gap-1.5">
        <button type="button" onClick={() => setOpen(false)} className="h-8 rounded-ctl px-2.5 text-[12.5px] font-semibold text-ink-500 hover:bg-sunken">
          {P.cancel}
        </button>
        <button type="submit" disabled={!valid || busy} className="h-8 rounded-ctl bg-brand-600 px-3 text-[12.5px] font-semibold text-white hover:bg-brand-700 disabled:opacity-45" data-fee-save>
          {P.save}
        </button>
      </div>
    </form>
  );
}
