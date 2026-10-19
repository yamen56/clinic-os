"use client";

/*
  A treatment's price, where the treatment is: in its card and in its entry.

  The price comes from the clinic's list: adding a treatment brings its price
  with it, so the reception can bill it. For one patient it can be changed
  (Yamen, 2026-10-15: "it says $100 — for this person I want it to be $120"):
  Edit price sets this patient's, the list stays as it is, and the invoice
  bills what was set. The doctor at the chair or the reception at the desk may
  do it, until the treatment is billed. It is billed once, whole, and paid off
  over the visits (Yamen, 2026-10-17): for whoever bills, the line says
  whether it is billed yet, and how much of it is paid.
*/

import { useState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtMoney } from "@/lib/dates";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { pickPrice, variantOf } from "@/lib/charts/dental/pricing";
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

/** "120 JOD", "90 JOD × 3 = 270 JOD" (a bridge's teeth) — null when unpriced. */
export function priceText(cash: Money, currency: string, locale: string): string | null {
  if (cash.fee == null) return null;
  const fmt = (n: number) => fmtMoney(n, currency, locale);
  return cash.units > 1 && cash.amount != null ? `${fmt(cash.fee)} × ${cash.units} = ${fmt(cash.amount)}` : fmt(cash.fee);
}

/** How much of a billed treatment is paid: "Paid 90 of 300 · 210 left", "300 to pay", "Paid in full". Null until billed. */
export function paidText(cash: Money, currency: string, locale: string, P: { paidOf: string; toPay: string; paidInFull: string }): string | null {
  if (!cash.billed || cash.charged <= 0) return null;
  const fmt = (n: number) => fmtMoney(n, currency, locale);
  if (cash.left <= 0) return P.paidInFull;
  if (cash.paid <= 0) return P.toPay.replace("{total}", fmt(cash.charged));
  return P.paidOf.replace("{paid}", fmt(cash.paid)).replace("{total}", fmt(cash.charged)).replace("{left}", fmt(cash.left));
}

/** The short form an entry shows in its line: the price and, for whoever bills, whether it is billed and paid. */
export function useEntryMoney(tz: string): (m: Mark) => string | undefined {
  const { t, locale } = useI18n();
  const P = t.dental.price;
  const store = useDentalStore();
  return (m: Mark) => {
    if (!priceable(m, store.marks)) return undefined;
    const cash = cashOf(m, store, tz);
    const parts = [
      priceText(cash, store.currency, locale) ?? P.none,
      store.canBill ? (cash.billed ? (paidText(cash, store.currency, locale, P) ?? P.billed) : cash.toBill ? P.notBilled : null) : null,
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
  // Set by the doctor or the desk, until it is on an invoice.
  const mayChoose = (store.canWrite || store.canBill) && !cash.billed;
  const text = priceText(cash, store.currency, locale);
  const paid = store.canBill ? paidText(cash, store.currency, locale, P) : null;
  // The list's price for it: what "Use the list price" goes back to.
  const list = pickPrice(store.prices, m.treatmentKey, variantOf(m.treatmentKey, m.detail));

  return (
    <div className="grid gap-1.5" data-price-line={m.id} data-amount={cash.amount ?? ""} data-fee-manual={m.feeManual ? "yes" : "no"}>
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
          <FeeEditor m={m} currency={store.currency} label={text ? P.edit : P.setForPatient} onSave={(fee) => w.setFee(m, fee)} />
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
      {/* Paid off over the visits, on the one invoice: how far it has got. */}
      {paid && (
        <div className="text-[12.5px] font-semibold tnum text-ink-700" data-paid-line={m.id} data-left={cash.left}>
          {paid}
        </div>
      )}
    </div>
  );
}

/** This patient's price, typed: a pencil that opens one field, the amount the list gave already in it. */
function FeeEditor({
  m,
  currency,
  label,
  onSave,
}: {
  m: Mark;
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
        {P.forPatient}
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
        <button type="submit" disabled={!valid || busy} className="h-8 rounded-ctl bg-brand-600 px-3 text-[12.5px] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-45" data-fee-save>
          {P.save}
        </button>
      </div>
    </form>
  );
}
