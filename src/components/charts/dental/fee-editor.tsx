"use client";

/*
  A treatment's price for this patient, where the treatment is.

  The same row in the treatment's card and in an entry on the tooth: the
  clinic's price unless the doctor changed it, what it comes to, and — for
  reception — whether it is billed. A treatment charted with no price says so
  in amber and asks for one here, rather than reaching the desk as a blank;
  and a doctor who may set prices can keep a price typed here for every
  patient ("Use for every patient"), which also prices the ones already
  waiting for it.
*/

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { fmtMoney } from "@/lib/dates";
import type { Mark } from "@/lib/charts/dental/state";
import { PER_SESSION_BY_DEFAULT, variantOf } from "@/lib/charts/dental/pricing";
import { saveDentalPriceAction } from "@/app/c/[slug]/settings/services/actions";
import { useDentalStore } from "./store";
import { useChartWriter } from "./writer";
import { moneyOf } from "./money";
import { INK, SOFT } from "./tooth-art";

/** This patient's price for the treatment, saved when the box is left. Emptied, the treatment has no price. */
function FeeBox({ value, onSave, label, missing }: { value: number | null; onSave: (v: number | null) => void; label: string; missing: boolean }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  return (
    <input
      type="text"
      inputMode="decimal"
      dir="ltr"
      aria-label={label}
      value={text}
      placeholder="—"
      onChange={(e) => /^\d{0,7}(\.\d{0,3})?$/.test(e.target.value) && setText(e.target.value)}
      onBlur={() => {
        const v = text.trim() === "" ? null : Number(text);
        if (v !== value) onSave(v);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`h-9 w-28 rounded-ctl border bg-surface px-2 text-end text-base font-semibold tnum focus:border-brand-600 focus:outline-none md:text-sm ${
        missing ? "border-st-pending" : "border-line"
      }`}
      data-fee
    />
  );
}

/** Priced or not: a treatment that can carry a price — work done to the patient, not what they came with. */
export function priceable(m: Mark): boolean {
  return m.kind === "procedure" && m.status !== "existing" && !m.voidedAt;
}

export function FeeEditor({ m, tz }: { m: Mark; tz: string }) {
  const { t, locale } = useI18n();
  const P = t.dental.treatment;
  const { toast } = useToast();
  const store = useDentalStore();
  const w = useChartWriter();
  const editable = store.canWrite && !m.voidedAt;
  const money = moneyOf(m, { marks: store.marks, steps: store.steps, prices: store.prices, billing: store.billing, billingSince: store.billingSince, tz });
  const missing = m.fee == null && priceable(m);

  /*
    "Use for every patient": a price typed here, for a treatment (or a kind of
    it) the clinic has not priced, or priced otherwise, becomes the clinic's
    price — for a doctor who may set prices. The dentist was not sure when
    prices would be set; at the chair, the first time, is one answer.
  */
  const variant = variantOf(m.treatmentKey, m.detail);
  const listed = store.prices.find((p) => p.chartKey === m.treatmentKey && p.variant === variant);
  const canList = store.canPrice && editable && m.kind === "procedure" && m.fee != null && m.fee > 0 && listed?.price !== m.fee;
  const listPrice = async () => {
    const unit = store.prices.find((p) => p.chartKey === m.treatmentKey)?.unit ?? (PER_SESSION_BY_DEFAULT.has(m.treatmentKey) ? "session" : "item");
    const r = await saveDentalPriceAction(store.slug, { key: m.treatmentKey, variant, price: m.fee, unit, linkServiceId: null, markId: m.id });
    if (r.error) {
      toast(P.useForAllFailed, "error");
      return;
    }
    toast(P.useForAllDone);
    void store.reload();
  };

  return (
    <div className="grid gap-1" data-price-row-card>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-[12px] font-semibold text-ink-500">{P.price}</span>
        {editable ? (
          // Keyed by the fee: a change of material re-prices it, and the box shows the new figure.
          <FeeBox key={String(m.fee)} value={m.fee} onSave={(v) => w.setFee(m, v)} label={P.price} missing={missing} />
        ) : (
          <span className={`font-semibold tnum ${missing ? "text-st-pending" : "text-ink-900"}`}>{m.fee != null ? fmtMoney(m.fee, store.currency, locale) : P.noPrice}</span>
        )}
        {editable && <span className="text-[12px] text-ink-500">{store.currency}</span>}
        {money.unit === "session" && <span className="text-[12px] text-ink-500">{P.perVisit}</span>}
        {money.units > 1 && money.amount != null && (
          <span className="text-[12px] text-ink-500 tnum">× {money.units} = {fmtMoney(money.amount, store.currency, locale)}</span>
        )}
        {store.canBill && (
          <span
            className="ms-auto rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
            style={money.billed ? { background: SOFT.done, color: INK.done } : { background: "var(--color-sunken)", color: "var(--color-ink-500)" }}
            data-billed={money.billed ? "yes" : "no"}
          >
            {money.billed ? `${P.billed} · ${money.invoices.map((i) => i.number).join(", ")}` : P.notBilled}
          </span>
        )}
      </div>
      {editable && (
        <p className={`flex flex-wrap items-center gap-x-2 text-[11.5px] ${missing ? "font-semibold text-st-pending" : "text-ink-400"}`}>
          {missing ? P.noPriceAsk : P.priceHint}
          {canList && (
            <button type="button" onClick={() => void listPrice()} className="font-semibold text-brand-700 hover:underline" data-use-for-all>
              {P.useForAll}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
