"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  sendInvoiceAction,
  recordPaymentAction,
  voidInvoiceAction,
  setInvoiceInsuranceAction,
} from "../actions";
import { MessageCircle, FileDown, ExternalLink, BadgeDollarSign, Ban, UserRound } from "lucide-react";

const invStatus: Record<string, StatusKey> = {
  draft: "neutral",
  sent: "pending",
  partially_paid: "pending",
  paid: "confirmed",
  void: "cancelled",
};

type Invoice = {
  id: string;
  number: string;
  status: string;
  currency: string;
  subtotal: string;
  discount_amount: string;
  tax_rate: string;
  tax_amount: string;
  total: string;
  amount_paid: string;
  insurer_amount: string;
  insurer_id: string | null;
  insurer_name: string | null;
  claim_status: string;
  notes: string;
  public_token: string;
  sent_at: string | null;
  created_at: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string | null;
  timezone: string;
  wa_connected: boolean;
};

export function InvoiceDetailClient({
  slug,
  invoice,
  items,
  payments,
  insurers,
}: {
  slug: string;
  invoice: Invoice;
  items: { description: string; qty: string; unit_price: string; amount: string }[];
  payments: { id: string; amount: string; method: string; reference: string; paid_at: string; recorded_by: string | null }[];
  /** Active companies. Empty for a clinic that only takes cash. */
  insurers: { id: string; name: string }[];
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const inv = invoice;
  const [payOpen, setPayOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const due = Number(inv.total) - Number(inv.amount_paid);
  const [amount, setAmount] = useState(due > 0 ? String(due) : "");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [insurerId, setInsurerId] = useState(inv.insurer_id ?? "");
  const [covered, setCovered] = useState(
    Number(inv.insurer_amount) > 0 ? String(Number(inv.insurer_amount)) : ""
  );
  const [claimStatus, setClaimStatus] = useState(inv.claim_status || "none");
  const [savingClaim, startClaim] = useTransition();
  const [pending, start] = useTransition();
  const [sendPending, startSend] = useTransition();

  const send = () =>
    startSend(async () => {
      const r = await sendInvoiceAction(slug, inv.id);
      if (r.error) {
        toast(
          r.error === "no_phone"
            ? t.invoices.noPhone
            : r.error === "wa_disconnected"
              ? t.invoices.waDisconnected
              : t.common.genericError,
          "error"
        );
        return;
      }
      toast(t.invoices.sentOk);
      router.refresh();
    });

  const pay = () =>
    start(async () => {
      const r = await recordPaymentAction(slug, {
        invoiceId: inv.id,
        amount: Number(amount),
        method,
        reference,
      });
      if (r.error) {
        toast(r.error === "overpay" ? t.invoices.overpay : t.common.genericError, "error");
        return;
      }
      toast(t.invoices.paymentSaved);
      setPayOpen(false);
      router.refresh();
    });

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3" dir="ltr">
            {inv.number}
            <Badge status={invStatus[inv.status]}>
              {(t.invoices.statuses as Record<string, string>)[inv.status]}
            </Badge>
          </span>
        }
        sub={`${inv.patient_name} · ${fmtDate(inv.created_at, inv.timezone, locale)}`}
        action={
          <div className="flex flex-wrap gap-2">
            <Link href={`/c/${slug}/patients/${inv.patient_id}`}>
              <Button variant="ghost" size="sm">
                <UserRound className="h-4 w-4" />
                {t.conversations.openPatient}
              </Button>
            </Link>
            <a href={`/inv/${inv.public_token}`} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm">
                <ExternalLink className="h-4 w-4" />
                {t.invoices.viewPublic}
              </Button>
            </a>
            <a href={`/api/c/${slug}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm">
                <FileDown className="h-4 w-4" />
                {t.invoices.downloadPdf}
              </Button>
            </a>
            {/*
              Sending stays available once the invoice is paid. A settled invoice
              is the patient's proof of payment — the thing they are asked for by
              an employer or an insurer — and hiding the button at exactly the
              moment it became worth sending meant there was no way to give it to
              them. Only a voided invoice has nothing worth sending.
            */}
            {inv.status !== "void" && (
              <Button size="sm" onClick={send} loading={sendPending}>
                <MessageCircle className="h-4 w-4" />
                {t.invoices.sendWhatsapp}
              </Button>
            )}
            {inv.status !== "void" && inv.status !== "paid" && (
              <Button variant="soft" size="sm" onClick={() => setPayOpen(true)}>
                <BadgeDollarSign className="h-4 w-4" />
                {t.invoices.recordPayment}
              </Button>
            )}
            {inv.status !== "void" && (
              <Button variant="ghost" size="sm" className="!text-danger" onClick={() => setVoidOpen(true)}>
                <Ban className="h-4 w-4" />
                {t.invoices.voidInvoice}
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t.invoices.item} />
          <table className="w-full text-sm">
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="px-5 py-2.5">{it.description}</td>
                  <td className="w-16 px-2 py-2.5 text-center tnum">{Number(it.qty)}</td>
                  <td className="w-28 px-2 py-2.5 text-end tnum">
                    {fmtMoney(Number(it.unit_price), inv.currency, locale)}
                  </td>
                  <td className="w-32 px-5 py-2.5 text-end font-medium tnum">
                    {fmtMoney(Number(it.amount), inv.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end px-5 py-4">
            <div className="w-60 space-y-1.5 text-sm">
              <div className="flex justify-between text-ink-500">
                <span>{t.invoices.subtotal}</span>
                <span className="tnum">{fmtMoney(Number(inv.subtotal), inv.currency, locale)}</span>
              </div>
              {Number(inv.discount_amount) > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>{t.invoices.discount}</span>
                  <span className="tnum">−{fmtMoney(Number(inv.discount_amount), inv.currency, locale)}</span>
                </div>
              )}
              {Number(inv.tax_rate) > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>{t.invoices.tax} ({Number(inv.tax_rate)}%)</span>
                  <span className="tnum">{fmtMoney(Number(inv.tax_amount), inv.currency, locale)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-line pt-2 text-base font-bold">
                <span>{t.invoices.total}</span>
                <span className="tnum">{fmtMoney(Number(inv.total), inv.currency, locale)}</span>
              </div>
              {/*
                The split, shown only when there is one. This is the number
                reception is asked for at the desk — "how much do I pay now" —
                and answering it from the total alone is how the wrong amount
                gets taken from an insured patient.
              */}
              {Number(inv.insurer_amount) > 0 && (
                <>
                  <div className="flex justify-between text-ink-500">
                    <span>{t.insurers.covered}</span>
                    <span className="tnum">
                      −{fmtMoney(Number(inv.insurer_amount), inv.currency, locale)}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <span>{t.insurers.patientPays}</span>
                    <span className="tnum">
                      {fmtMoney(Number(inv.total) - Number(inv.insurer_amount), inv.currency, locale)}
                    </span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-ink-500">
                <span>{t.invoices.paid}</span>
                <span className="tnum">{fmtMoney(Number(inv.amount_paid), inv.currency, locale)}</span>
              </div>
              <div className={`flex justify-between font-semibold ${due > 0 ? "text-st-pending" : "text-brand-700"}`}>
                <span>{t.invoices.due}</span>
                <span className="tnum">{fmtMoney(due, inv.currency, locale)}</span>
              </div>
            </div>
          </div>
        </Card>

        {/*
          The claim, kept beside the invoice rather than inside it. What a
          company agrees to cover arrives days after the work was priced, and
          editing the invoice to record it would change what the patient was
          shown and signed for.
        */}
        {insurers.length > 0 && (
          <Card className="h-fit">
            <CardHeader title={t.insurers.claim} />
            <div className="grid gap-3 p-5">
              <Field label={t.insurers.insurer}>
                <Select
                  value={insurerId}
                  onChange={(e) => setInsurerId(e.target.value)}
                  disabled={inv.status === "void"}
                >
                  <option value="">{t.insurers.none}</option>
                  {insurers.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label={`${t.insurers.covered} (${inv.currency})`}>
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  value={covered}
                  onChange={(e) => setCovered(e.target.value)}
                  disabled={inv.status === "void" || !insurerId}
                />
              </Field>
              <Field label={t.insurers.claim}>
                <Select
                  value={claimStatus}
                  onChange={(e) => setClaimStatus(e.target.value)}
                  disabled={inv.status === "void" || !insurerId}
                >
                  {["none", "to_submit", "submitted", "approved", "rejected", "paid"].map((s) => (
                    <option key={s} value={s}>
                      {(t.insurers.claimStatus as Record<string, string>)[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="outline"
                loading={savingClaim}
                disabled={inv.status === "void"}
                onClick={() =>
                  startClaim(async () => {
                    const r = await setInvoiceInsuranceAction(slug, inv.id, {
                      insurerId: insurerId || null,
                      insurerAmount: Number(covered) || 0,
                      claimStatus,
                    });
                    if (r.error) return toast(r.error, "error");
                    router.refresh();
                    toast(t.common.saved, "success");
                  })
                }
              >
                {t.common.save}
              </Button>
            </div>
          </Card>
        )}

        <Card className="h-fit">
          <CardHeader title={t.invoices.payments} />
          {payments.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-ink-400">{t.common.none}</p>
          ) : (
            <ul className="divide-y divide-line">
              {payments.map((p) => (
                <li key={p.id} className="px-5 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold tnum">
                      {fmtMoney(Number(p.amount), inv.currency, locale)}
                    </span>
                    <Badge status="brand">
                      {(t.invoices.methods as Record<string, string>)[p.method] ?? p.method}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-400">
                    {fmtDateTime(p.paid_at, inv.timezone, locale)}
                    {p.recorded_by ? ` · ${p.recorded_by}` : ""}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title={t.invoices.recordPayment}>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={`${t.common.amount} (${inv.currency})`} required>
              <Input type="number" dir="ltr" min={0} step="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </Field>
            <Field label={t.invoices.method}>
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(t.invoices.methods).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t.invoices.reference} hint={t.common.optional}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPayOpen(false)}>{t.common.cancel}</Button>
            <Button onClick={pay} loading={pending} disabled={!(Number(amount) > 0)}>
              {t.common.save}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title={t.invoices.voidConfirm}
        body={t.invoices.voidBody}
        confirmLabel={t.invoices.voidInvoice}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          setVoidOpen(false);
          await voidInvoiceAction(slug, inv.id);
          router.refresh();
        }}
      />
    </>
  );
}
