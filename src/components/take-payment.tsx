"use client";

/*
  Take a payment from a patient, toward whatever they owe.

  A treatment is billed once, whole, and paid off over the visits (Yamen,
  2026-10-17). At each visit the desk takes what the patient hands over and
  does not hunt for the invoice it belongs to: the server puts it on their
  open invoices, the oldest first (recordPatientPaymentAction).

  The amount starts at everything owed and can be changed. The balance shown
  beside the button drops the moment the payment is saved; the server's
  figure replaces it when the page re-reads.
*/

import { useEffect, useState, useTransition } from "react";
import { Check, ReceiptText, Wallet } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtMoney } from "@/lib/dates";
import { useToast } from "@/components/ui/toast";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { recordPatientPaymentAction, sendReceiptAction } from "@/app/c/[slug]/(finance)/invoices/actions";

export function TakePayment({
  slug,
  patientId,
  balance,
  currency,
  size = "sm",
  showBalance = false,
  onPaid,
}: {
  slug: string;
  patientId: string;
  /** What the patient owes, as the page read it. */
  balance: number;
  currency: string;
  size?: "sm" | "md";
  /** "Owes 210 JOD" beside the button, where the balance is not already on screen. */
  showBalance?: boolean;
  /** Told what was paid, for a balance drawn elsewhere on the screen. */
  onPaid?: (amount: number) => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [owed, setOwed] = useState(balance);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [pending, start] = useTransition();
  /* The invoices this payment settled, while their receipts are on offer. */
  const [receipts, setReceipts] = useState<{ id: string; number: string; sent: boolean }[] | null>(null);
  const [sendingReceipt, setSendingReceipt] = useState<string | null>(null);
  // A fresh read of the page is the truth again.
  useEffect(() => setOwed(balance), [balance]);

  // Paid off with the receipts still on offer: the modal stays until it is closed.
  if (!(owed > 0) && !(open && receipts)) return null;
  const value = Number(amount.replace(",", "."));
  const valid = Number.isFinite(value) && value > 0 && value <= owed + 0.001;

  const save = () =>
    start(async () => {
      const r = await recordPatientPaymentAction(slug, { patientId, amount: value, method, reference });
      if (r.error || !r.paid) {
        toast(r.error === "overpay" ? t.invoices.overpay : r.error === "nothing_due" ? t.invoices.nothingDue : t.common.genericError, "error");
        return;
      }
      setOwed((o) => Math.max(0, Math.round((o - value) * 100) / 100));
      onPaid?.(value);
      toast(t.invoices.paidOnto.replace("{list}", r.paid.map((p) => p.number).join(", ")));
      /*
        Settled: the patient is at the desk and asks for proof of payment now,
        not after somebody finds the invoice. The receipt is offered here.
      */
      const settled = r.paid.filter((p) => p.settled);
      if (settled.length) setReceipts(settled.map((p) => ({ id: p.invoiceId, number: p.number, sent: false })));
      else setOpen(false);
    });

  const sendReceipt = async (id: string) => {
    setSendingReceipt(id);
    const r = await sendReceiptAction(slug, id).finally(() => setSendingReceipt(null));
    if (r.error) {
      toast(r.error === "no_phone" ? t.invoices.noPhone : r.error === "wa_disconnected" ? t.invoices.waDisconnected : t.common.genericError, "error");
      return;
    }
    setReceipts((xs) => xs?.map((x) => (x.id === id ? { ...x, sent: true } : x)) ?? null);
    toast(t.invoices.receiptSent);
  };

  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-2" data-take-payment={patientId} data-owed={owed}>
        {showBalance && (
          <span className="text-[12.5px] font-semibold tnum text-st-pending">{t.invoices.owes.replace("{amount}", fmtMoney(owed, currency, locale))}</span>
        )}
        <Button
          variant="soft"
          size={size}
          onClick={() => {
            setAmount(String(owed));
            setReference("");
            setReceipts(null);
            setOpen(true);
          }}
        >
          <Wallet className="h-4 w-4" />
          {t.invoices.takePayment}
        </Button>
      </span>
      <Modal open={open} onClose={() => setOpen(false)} title={t.invoices.takePaymentTitle}>
        {receipts ? (
          <div className="grid gap-3" data-take-payment-receipts>
            <p className="text-[13px] text-ink-700">{t.invoices.settledSendReceipt}</p>
            {receipts.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <span className="text-sm font-semibold tnum">{r.number}</span>
                {r.sent ? (
                  <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-st-confirmed">
                    <Check className="h-4 w-4" />
                    {t.invoices.receiptSent}
                  </span>
                ) : (
                  <Button size="sm" loading={sendingReceipt === r.id} onClick={() => void sendReceipt(r.id)} data-take-payment-send-receipt>
                    <ReceiptText className="h-4 w-4" />
                    {t.invoices.sendReceipt}
                  </Button>
                )}
              </div>
            ))}
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t.common.close}
              </Button>
            </div>
          </div>
        ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save();
          }}
          data-take-payment-form
        >
          <p className="text-[13px] text-ink-500">
            {t.invoices.owes.replace("{amount}", fmtMoney(owed, currency, locale))} · {t.invoices.takePaymentHint}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label={`${t.common.amount} (${currency})`} required>
              <Input
                inputMode="decimal"
                dir="ltr"
                value={amount}
                onChange={(e) => /^\d{0,7}([.,]\d{0,2})?$/.test(e.target.value) && setAmount(e.target.value)}
                autoFocus
                data-take-payment-amount
              />
            </Field>
            <Field label={t.invoices.method}>
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(t.invoices.methods).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t.invoices.reference} hint={t.common.optional}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={pending} disabled={!valid} data-take-payment-save>
              {t.common.save}
            </Button>
          </div>
        </form>
        )}
      </Modal>
    </>
  );
}
