"use client";

/*
  Billing from the treatment record: what the doctor recorded that is not on
  an invoice yet, on the patient's Invoices tab — beside the tooth chart's
  card and the face chart's, and by the same rule (billing-server dueSql):
  done, standing, not free, and on no invoice that stands.

  Each line is ticked; untick what is not going on this bill. Bill opens the
  invoice with the lines as the price list words them. A treatment typed by
  hand has no price here: reception sets it on the invoice.
*/

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { buttonClass } from "@/components/ui/button-class";
import { fmtDate, fmtMoney } from "@/lib/dates";
import { standing } from "@/lib/treatment/visits";
import { useOptionalTreatmentStore } from "./store";

export function TreatmentReadyToBill({ className = "mb-4 p-4" }: { className?: string }) {
  const { t, locale } = useI18n();
  const I = t.invoices;
  const T = t.treatment;
  const store = useOptionalTreatmentStore();
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  if (!store || !store.canBill) return null;

  const billedQty = new Map(store.billing.map((b) => [b.markId, b.qty]));
  const ready = standing(store.marks).filter((m) => m.fee !== 0 && !(billedQty.get(m.id) ?? 0));
  if (!ready.length) return null;
  const chosen = ready.filter((m) => !unticked.has(m.id));
  const total = chosen.reduce((n, m) => n + (m.fee ?? 0), 0);
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  const toggle = (id: string) =>
    setUnticked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div data-treatment-billing={ready.length}>
      <Card className={className}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">{I.readyToBill}</h3>
            <p className="mt-0.5 text-[13px] text-ink-500">{T.readyHint}</p>
          </div>
          {chosen.length > 0 && (
            <a
              href={`/c/${store.slug}/invoices/new?patient=${store.patientId}&marks=${chosen.map((m) => m.id).join(",")}`}
              className={buttonClass({ size: "sm" })}
              data-treatment-bill
            >
              {T.bill.replace("{n}", String(chosen.length)).replace("{total}", fmt(total))}
            </a>
          )}
        </div>
        <ul className="mt-3 overflow-hidden rounded-ctl border border-line">
          {ready.map((m) => {
            const on = !unticked.has(m.id);
            const name = (locale === "ar" && m.labelAr) || m.label;
            return (
              <li key={m.id} className={`border-t border-line first:border-t-0 ${on ? "" : "bg-sunken"}`} data-treatment-line={m.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
                  <input type="checkbox" className="h-4.5 w-4.5 shrink-0 accent-brand-600" checked={on} onChange={() => toggle(m.id)} aria-label={name} />
                  <span className={`min-w-0 flex-1 ${on ? "" : "text-ink-500"}`}>
                    <span className="block text-[13px] font-medium" dir="auto">
                      {name}
                    </span>
                    <span className="block text-[12px] text-ink-500">
                      {fmtDate(m.doneAt ?? m.createdAt, store.tz, locale)}
                      {m.performedBy?.name ? ` · ${m.performedBy.name}` : ""}
                    </span>
                  </span>
                  <span className={`shrink-0 text-[13.5px] font-semibold tnum ${m.fee == null ? "text-st-pending" : on ? "" : "text-ink-500 line-through"}`}>
                    {m.fee == null ? I.noPriceYet : fmt(m.fee)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
