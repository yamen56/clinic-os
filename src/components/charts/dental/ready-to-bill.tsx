"use client";

/*
  What the receptionist bills: the patient's chart work that is done or under
  way and not on an invoice yet.

  The dentist asked that reception see what the patient had and bill it. This
  card sits at the top of the patient's Invoices tab, in the reader's
  language — each line reads as the invoice builder will write it — with what
  is still owed and the total, and one button that opens the invoice with
  those lines already written.
*/

import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { buttonClass } from "@/components/ui/button-class";
import { fmtMoney } from "@/lib/dates";
import { isToothSite } from "@/lib/charts/dental/state";
import { groupLeads, inChartOrder, leadOf } from "@/lib/charts/dental/full-arch";
import { lineDescription } from "@/lib/charts/dental/pricing";
import { useOptionalDentalStore } from "./store";
import { moneyOf } from "./money";

export function ReadyToBill({ tz }: { tz: string }) {
  const { t, locale } = useI18n();
  const store = useOptionalDentalStore();
  if (!store || !store.canBill) return null;
  const leads = groupLeads(store.marks);
  const ctx = { marks: store.marks, steps: store.steps, prices: store.prices, billing: store.billing, billingSince: store.billingSince, tz };
  const items = store.marks
    .filter((m) => !m.voidedAt && m.kind === "procedure" && m.status !== "existing" && !leadOf(m, leads))
    .map((m) => ({ m, cash: moneyOf(m, ctx) }))
    .filter((x) => x.cash.toBill);
  if (!items.length) return null;
  const total = items.reduce((sum, x) => sum + (x.cash.due ?? 0), 0);
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  // A bridge reads as its teeth, as the invoice line will; a full arch reads as its arch.
  const teethOf = (groupId: string | undefined) => {
    if (!groupId) return [];
    const mates = store.marks.filter((x) => x.groupId === groupId && !x.voidedAt);
    return mates.length > 1 && mates.every((x) => isToothSite(x.site)) ? inChartOrder(mates.map((x) => x.site)) : [];
  };

  return (
    <div data-ready-to-bill={items.length} data-ready-total={total}>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">{t.invoices.readyToBill}</h3>
            <p className="mt-0.5 text-[13px] text-ink-500">{t.invoices.readyToBillHint}</p>
          </div>
          <a
            href={`/c/${store.slug}/invoices/new?patient=${store.patientId}&marks=${items.map((x) => x.m.id).join(",")}`}
            className={buttonClass({ size: "sm" })}
            data-bill-ready
          >
            {t.invoices.billThese}
            {total > 0 && <span className="tnum"> · {fmt(total)}</span>}
          </a>
        </div>
        <ul className="mt-3 divide-y divide-line">
          {items.map(({ m, cash }) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-[13px]" data-ready-item={m.id}>
              <span className="min-w-0">
                {lineDescription(m, locale, t.invoices.chartLine, teethOf(m.groupId))}
                {cash.dueUnits > 1 && <span className="text-ink-500 tnum"> × {cash.dueUnits}</span>}
              </span>
              <span className="shrink-0 font-semibold tnum">{cash.due != null ? fmt(cash.due) : "—"}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
