"use client";

/*
  Billing from the chart: what the receptionist bills, and what is billed.

  The dentist asked that reception see what the patient had and bill it. This
  card sits on the patient's Invoices tab and on the Dental chart tab, in the
  reader's language — each line reads as the invoice builder will write it.

  Yamen, 2026-10-19: "I want to be able to choose which one I create this bill
  for, have the ability to delete them, and make sure I have done these
  invoices for the patient". So:

  - Ready to bill: the work done or under way and not on an invoice yet, each
    ticked, untick what is not going on this bill. Planned work, not started,
    can be ticked too — a patient who pays before the crown is made.
  - Billed: every invoice made from the chart, with the treatments on it and
    what is paid of it. One made by mistake — nothing paid on it, never filed
    with JoFotara — is deleted from here, and its work is ready to bill again.
*/

import { useState } from "react";
import Link from "next/link";
import { Check, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { buttonClass } from "@/components/ui/button-class";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { fmtMoney } from "@/lib/dates";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { groupLeads, inChartOrder, leadOf } from "@/lib/charts/dental/full-arch";
import { invoiceLineText } from "@/lib/charts/dental/pricing";
import type { BilledInvoice } from "@/lib/charts/dental/billing-server";
import { deleteBilledInvoiceAction, removeFromBillingAction } from "@/app/c/[slug]/(finance)/invoices/actions";
import { useOptionalDentalStore } from "./store";
import { moneyOf } from "./money";

export function ReadyToBill({ tz, className = "mb-4 p-4" }: { tz: string; className?: string }) {
  const { t, locale } = useI18n();
  const I = t.invoices;
  const { toast } = useToast();
  const store = useOptionalDentalStore();
  // Ticks the reader changed: ready work unticked, planned work ticked.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<BilledInvoice | null>(null);
  const [removing, setRemoving] = useState<Mark | null>(null);
  const [busy, setBusy] = useState(false);
  if (!store || !store.canBill) return null;

  const leads = groupLeads(store.marks);
  const ctx = { marks: store.marks, steps: store.steps, prices: store.prices, billing: store.billing, billingSince: store.billingSince, tz };
  const work = store.marks
    .filter((m) => !m.voidedAt && m.kind === "procedure" && m.status !== "existing" && !leadOf(m, leads))
    .map((m) => ({ m, cash: moneyOf(m, ctx) }));
  const ready = work.filter((x) => x.cash.toBill);
  // Planned, not started, priced and on no invoice: billable ahead of the work.
  const ahead = work.filter((x) => x.m.status === "planned" && !x.m.startedAt && !x.cash.billed && x.m.fee != null && x.m.fee > 0);
  const isTicked = (id: string, isReady: boolean) => (isReady ? !unticked.has(id) : ticked.has(id));
  const chosen = [...ready.filter((x) => isTicked(x.m.id, true)), ...ahead.filter((x) => isTicked(x.m.id, false))];
  const chosenTotal = chosen.reduce((sum, x) => sum + (x.cash.toBill ? (x.cash.due ?? 0) : (x.cash.amount ?? 0)), 0);
  const readyTotal = ready.reduce((sum, x) => sum + (x.cash.due ?? 0), 0);

  // The invoices made from the chart, each with the treatments on it.
  const billed = new Map<string, { inv: BilledInvoice; marks: Mark[] }>();
  for (const b of store.billing) {
    const m = store.marks.find((x) => x.id === b.markId);
    if (!m) continue;
    for (const inv of b.invoices) {
      const row = billed.get(inv.id) ?? { inv, marks: [] };
      row.marks.push(m);
      billed.set(inv.id, row);
    }
  }
  const invoices = [...billed.values()].sort((a, b) => b.inv.number.localeCompare(a.inv.number));

  if (!ready.length && !ahead.length && !invoices.length) return null;
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  // A bridge reads as its teeth, as the invoice line will; a full arch reads as its arch.
  const teethOf = (groupId: string | undefined) => {
    if (!groupId) return [];
    const mates = store.marks.filter((x) => x.groupId === groupId && !x.voidedAt);
    return mates.length > 1 && mates.every((x) => isToothSite(x.site)) ? inChartOrder(mates.map((x) => x.site)) : [];
  };
  const lineOf = (m: Mark) => invoiceLineText(m, store.prices.find((p) => p.serviceId === m.serviceId), locale, I.chartLine, teethOf(m.groupId));

  const toggle = (id: string, isReady: boolean) => {
    const set = isReady ? setUnticked : setTicked;
    set((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    const r = await deleteBilledInvoiceAction(store.slug, deleting.id);
    setBusy(false);
    setDeleting(null);
    if (r.error) {
      toast(r.error === "has_payments" ? I.deleteBillPaid : r.error === "filed" ? I.deleteBillFiled : t.common.genericError, "error");
      return;
    }
    toast(I.deleteBillDone);
    void store.reload();
  };

  // Off the list, still on the chart at no charge (removeFromBillingAction), 2026-10-28.
  const takeOff = async () => {
    if (!removing) return;
    const m = removing;
    setBusy(true);
    const r = await store.write([m.id], removeFromBillingAction(store.slug, m.id));
    setBusy(false);
    setRemoving(null);
    if (r.error) {
      toast(I.removeFailed, "error");
      return;
    }
    toast(I.removed);
    void store.reload();
  };

  const row = (m: Mark, amount: number | null, isReady: boolean) => (
    <li key={m.id} className="flex items-center gap-3 py-2 text-[13px]" data-ready-item={isReady ? m.id : undefined} data-ahead-item={isReady ? undefined : m.id}>
      <input
        type="checkbox"
        className="h-4.5 w-4.5 shrink-0 accent-brand-600"
        checked={isTicked(m.id, isReady)}
        onChange={() => toggle(m.id, isReady)}
        aria-label={lineOf(m)}
        data-bill-pick={m.id}
      />
      <span className="min-w-0 flex-1">{lineOf(m)}</span>
      <span className="shrink-0 font-semibold tnum">{amount != null ? fmt(amount) : "—"}</span>
      {isReady && (
        <button
          type="button"
          onClick={() => setRemoving(m)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-500 hover:bg-danger-soft hover:text-danger"
          aria-label={`${I.remove}: ${lineOf(m)}`}
          title={I.remove}
          data-bill-remove={m.id}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </li>
  );

  return (
    <div data-chart-billing>
      <Card className={className}>
        {(ready.length > 0 || ahead.length > 0) && (
          <div data-ready-to-bill={ready.length || undefined} data-ready-total={readyTotal}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold">{I.readyToBill}</h3>
                <p className="mt-0.5 text-[13px] text-ink-500">{I.readyToBillHint}</p>
              </div>
              {chosen.length > 0 ? (
                <a
                  href={`/c/${store.slug}/invoices/new?patient=${store.patientId}&marks=${chosen.map((x) => x.m.id).join(",")}`}
                  className={buttonClass({ size: "sm" })}
                  data-bill-ready
                >
                  {I.billSelected.replace("{n}", String(chosen.length))}
                  {chosenTotal > 0 && <span className="tnum"> · {fmt(chosenTotal)}</span>}
                </a>
              ) : (
                <span className={buttonClass({ size: "sm", variant: "outline", className: "pointer-events-none opacity-60" })}>{I.billNone}</span>
              )}
            </div>
            {ready.length > 0 && <ul className="mt-2 divide-y divide-line">{ready.map((x) => row(x.m, x.cash.due, true))}</ul>}
            {ahead.length > 0 && (
              <div className="mt-3" data-bill-ahead={ahead.length}>
                <div className="text-[12px] font-semibold text-ink-500">{I.notStarted}</div>
                <div className="text-[12px] text-ink-400">{I.notStartedHint}</div>
                <ul className="mt-1 divide-y divide-line">{ahead.map((x) => row(x.m, x.cash.amount, false))}</ul>
              </div>
            )}
          </div>
        )}

        {invoices.length > 0 && (
          <div className={ready.length || ahead.length ? "mt-4 border-t border-line pt-4" : ""} data-billed-list={invoices.length}>
            <h3 className="text-[15px] font-semibold">{I.billedTitle}</h3>
            <p className="mt-0.5 text-[13px] text-ink-500">{I.billedHint}</p>
            <ul className="mt-2 grid gap-2">
              {invoices.map(({ inv, marks }) => {
                const total = inv.total ?? 0;
                const paid = inv.paid ?? 0;
                const status = paid <= 0 ? I.billedUnpaid : paid >= total ? I.billedPaidInFull : I.billedPaidOf.replace("{paid}", fmt(paid)).replace("{total}", fmt(total));
                const deletable = store.canDeleteInvoices && paid <= 0 && !inv.filed;
                return (
                  <li key={inv.id} className="rounded-ctl border border-line px-3 py-2.5" data-billed-invoice={inv.id}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                      <Check className="h-4 w-4 shrink-0 text-st-confirmed" />
                      <Link href={`/c/${store.slug}/invoices/${inv.id}`} className="font-semibold text-ink-900 hover:underline" dir="ltr">
                        {inv.number}
                      </Link>
                      <span className="text-ink-500 tnum">· {fmt(total)}</span>
                      <span className={`tnum ${paid >= total && total > 0 ? "text-st-confirmed" : "text-ink-500"}`}>· {status}</span>
                      <span className="ms-auto flex gap-1.5">
                        <Link href={`/c/${store.slug}/invoices/${inv.id}`} className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-semibold text-brand-700 hover:bg-sunken">
                          {I.openInvoice}
                        </Link>
                        {deletable && (
                          <button
                            type="button"
                            onClick={() => setDeleting(inv)}
                            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-ink-500 hover:bg-danger-soft hover:text-danger"
                            data-delete-bill={inv.id}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {I.deleteBill}
                          </button>
                        )}
                      </span>
                    </div>
                    <ul className="mt-1 grid gap-0.5 ps-6 text-[12.5px] text-ink-700">
                      {marks.map((m) => (
                        <li key={m.id}>{lineOf(m)}</li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => void takeOff()}
        title={I.removeTitle}
        body={removing ? I.removeBody.replace("{line}", lineOf(removing)) : ""}
        confirmLabel={I.remove}
        cancelLabel={t.common.cancel}
        loading={busy}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={I.deleteBillTitle.replace("{number}", deleting?.number ?? "")}
        body={I.deleteBillBody}
        confirmLabel={I.deleteBill}
        cancelLabel={t.common.cancel}
        loading={busy}
      />
    </div>
  );
}
