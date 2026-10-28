"use client";

/*
  Billing from the face chart: what reception bills, and what is billed.

  On the Face chart tab and on the patient's Invoices tab, in the reader's
  language — each line reads as the invoice builder will write it. Every
  treatment done and on no invoice yet is ticked; untick what is not going on
  this bill. The rule is the desk's (billing-server dueSql): done, not voided,
  not free, and not on an invoice that stands.

  Remove takes one off the list (it stays on the chart, at no charge), and an
  invoice made by mistake — nothing paid, never filed — is deleted from the
  Billed list, which puts its work back here: the dental chart's card does the
  same (2026-10-19, 2026-10-28).
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
import { faceLineText } from "@/lib/charts/face/catalog";
import type { FaceMark } from "@/lib/charts/face/db";
import type { BilledInvoice } from "@/lib/charts/dental/billing-server";
import { deleteBilledInvoiceAction, removeFromBillingAction } from "@/app/c/[slug]/(finance)/invoices/actions";
import { useOptionalFaceStore } from "./store";

export function FaceReadyToBill({ className = "mb-4 p-4" }: { className?: string }) {
  const { t, locale } = useI18n();
  const I = t.invoices;
  const { toast } = useToast();
  const store = useOptionalFaceStore();
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<FaceMark | null>(null);
  const [deleting, setDeleting] = useState<BilledInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  if (!store || !store.canBill) return null;

  const billedQty = new Map(store.billing.map((b) => [b.markId, b.qty]));
  const ready = store.marks.filter((m) => !m.voidedAt && m.doneAt && m.fee !== 0 && !(billedQty.get(m.id) ?? 0));
  const chosen = ready.filter((m) => !unticked.has(m.id));
  const total = chosen.reduce((n, m) => n + (m.fee ?? 0), 0);

  const billed = new Map<string, { inv: BilledInvoice; marks: FaceMark[] }>();
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
  if (!ready.length && !invoices.length) return null;

  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  const lineOf = (m: FaceMark) => {
    const row = store.prices.find((p) => p.serviceId === m.serviceId);
    return faceLineText(m, row ? { name: row.name, nameAr: row.nameAr } : null, locale);
  };
  const toggle = (id: string) =>
    setUnticked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const remove = async () => {
    if (!removing) return;
    const m = removing;
    setBusy(true);
    const r = await store.write([m.id], removeFromBillingAction(store.slug, m.id));
    setBusy(false);
    setRemoving(null);
    if (r.error) return toast(I.removeFailed, "error");
    store.setMarks((prev) => prev.map((x) => (x.id === m.id ? { ...x, fee: 0, feeManual: true } : x)));
    toast(I.removed);
  };

  const deleteInvoice = async () => {
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

  return (
    <div data-face-billing>
      <Card className={className}>
        {ready.length > 0 && (
          <div data-face-ready={ready.length}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold">{I.readyToBill}</h3>
                <p className="mt-0.5 text-[13px] text-ink-500">{I.readyToBillHint}</p>
              </div>
              {chosen.length > 0 ? (
                <a
                  href={`/c/${store.slug}/invoices/new?patient=${store.patientId}&marks=${chosen.map((m) => m.id).join(",")}`}
                  className={buttonClass({ size: "sm" })}
                  data-face-bill
                >
                  {I.billPicked.replace("{n}", String(chosen.length)).replace("{total}", fmt(total))}
                </a>
              ) : (
                <span className={buttonClass({ size: "sm", variant: "outline", className: "pointer-events-none opacity-60" })}>{I.billNone}</span>
              )}
            </div>
            <ul className="mt-2.5 overflow-hidden rounded-ctl border border-line">
              {ready.map((m) => {
                const on = !unticked.has(m.id);
                return (
                  <li key={m.id} className={`flex items-center gap-3 border-t border-line px-3 py-2 text-[13px] first:border-t-0 ${on ? "" : "bg-sunken"}`} data-face-ready-item={m.id}>
                    <input type="checkbox" className="h-4.5 w-4.5 shrink-0 accent-brand-600" checked={on} onChange={() => toggle(m.id)} aria-label={lineOf(m)} />
                    <span className={`min-w-0 flex-1 ${on ? "" : "text-ink-500"}`} dir="auto">
                      {lineOf(m)}
                      {m.performedBy && <span className="block text-[12px] text-ink-500">{m.performedBy.name}</span>}
                    </span>
                    {m.fee != null ? (
                      <span className={`shrink-0 font-semibold tnum ${on ? "" : "text-ink-500 line-through"}`}>{fmt(m.fee)}</span>
                    ) : (
                      <span className="shrink-0 text-[12px] font-semibold text-st-pending">{I.noPriceYet}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setRemoving(m)}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-500 hover:bg-danger-soft hover:text-danger"
                      aria-label={`${I.remove}: ${lineOf(m)}`}
                      title={I.remove}
                      data-face-ready-remove={m.id}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {invoices.length > 0 && (
          <div className={ready.length ? "mt-4 border-t border-line pt-4" : ""} data-face-billed={invoices.length}>
            <h3 className="text-[15px] font-semibold">{I.billedTitle}</h3>
            <ul className="mt-2 grid gap-2">
              {invoices.map(({ inv, marks }) => {
                const invTotal = inv.total ?? 0;
                const paid = inv.paid ?? 0;
                const status =
                  paid <= 0 ? I.billedUnpaid : paid >= invTotal ? I.billedPaidInFull : I.billedPaidOf.replace("{paid}", fmt(paid)).replace("{total}", fmt(invTotal));
                const deletable = store.canDeleteInvoices && paid <= 0 && !inv.filed;
                return (
                  <li key={inv.id} className="rounded-ctl border border-line px-3 py-2.5" data-face-billed-invoice={inv.id}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                      <Check className="h-4 w-4 shrink-0 text-st-confirmed" />
                      <Link href={`/c/${store.slug}/invoices/${inv.id}`} className="font-semibold text-ink-900 hover:underline" dir="ltr">
                        {inv.number}
                      </Link>
                      <span className="text-ink-500 tnum">· {fmt(invTotal)}</span>
                      <span className={`tnum ${paid >= invTotal && invTotal > 0 ? "text-st-confirmed" : "text-ink-500"}`}>· {status}</span>
                      <span className="ms-auto flex gap-1.5">
                        <Link href={`/c/${store.slug}/invoices/${inv.id}`} className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-semibold text-brand-700 hover:bg-sunken">
                          {I.openInvoice}
                        </Link>
                        {deletable && (
                          <button
                            type="button"
                            onClick={() => setDeleting(inv)}
                            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-ink-500 hover:bg-danger-soft hover:text-danger"
                            data-face-delete-bill={inv.id}
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
        onConfirm={() => void remove()}
        title={I.removeTitle}
        body={removing ? I.removeBody.replace("{line}", lineOf(removing)) : ""}
        confirmLabel={I.remove}
        cancelLabel={t.common.cancel}
        loading={busy}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void deleteInvoice()}
        title={I.deleteBillTitle.replace("{number}", deleting?.number ?? "")}
        body={I.deleteBillBody}
        confirmLabel={I.deleteBill}
        cancelLabel={t.common.cancel}
        loading={busy}
      />
    </div>
  );
}
