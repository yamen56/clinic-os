"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/dates";
import { asTaxCategory, taxBreakdown } from "@/lib/invoices";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  sendInvoiceAction,
  recordPaymentAction,
  voidInvoiceAction,
  setInvoiceInsuranceAction,
  retryEinvoiceAction,
  setInvoiceTitleAction,
  setInvoiceFilingAction,
} from "../actions";
import {
  MessageCircle,
  FileDown,
  ExternalLink,
  BadgeDollarSign,
  Ban,
  UserRound,
  TriangleAlert,
  Landmark,
} from "lucide-react";

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
  title: string;
  file_einvoice: boolean;
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
  einvoice_status: string;
  einvoice_error: string | null;
  einvoice_uuid: string | null;
  credit_note_of: string | null;
  corrects_number: string | null;
  credit_note_id: string | null;
  credit_note_number: string | null;
};

const einvStatus: Record<string, StatusKey> = {
  pending: "pending",
  submitted: "confirmed",
  failed: "danger",
};

export function InvoiceDetailClient({
  slug,
  invoice,
  items,
  payments,
  insurers,
  filesEinvoices,
}: {
  slug: string;
  invoice: Invoice;
  items: {
    description: string;
    qty: string;
    unit_price: string;
    amount: string;
    discount_amount: string;
    tax_category: string;
    tax_rate: string;
    tax_amount: string;
  }[];
  payments: { id: string; amount: string; method: string; reference: string; paid_at: string; recorded_by: string | null }[];
  /** Active companies. Empty for a clinic that only takes cash. */
  insurers: { id: string; name: string }[];
  /** Whether this clinic files with JoFotara and has the credentials to do it. */
  filesEinvoices: boolean;
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
  const [retrying, startRetry] = useTransition();
  const [voidReason, setVoidReason] = useState("");
  const [title, setTitle] = useState(inv.title ?? "");
  const [savingTitle, startTitle] = useTransition();
  const [fileEinvoice, setFileEinvoice] = useState(inv.file_einvoice);
  const [savingFiling, startFiling] = useTransition();
  /** Filed with ISTD, so cancelling means a credit note rather than a delete. */
  const filed = inv.einvoice_status === "submitted";
  /*
    Once ISTD holds the document, or while we do not yet know whether they do,
    the switch is no longer a switch — the way back is a credit note. Shown
    locked with the reason rather than hidden, so the state is legible.
  */
  const filingLocked =
    inv.status === "void" ||
    inv.einvoice_status === "submitted" ||
    inv.einvoice_status === "pending";

  /*
    Saved on blur, not on every keystroke. A title is typed in one go and this
    is a server action rather than the autosave endpoint the patient file uses;
    firing per character would be a write per letter for no benefit.
  */
  const saveTitle = () => {
    const next = title.trim();
    if (next === (inv.title ?? "").trim()) return;
    startTitle(async () => {
      const r = await setInvoiceTitleAction(slug, inv.id, next);
      if (r.error) {
        setTitle(inv.title ?? "");
        return toast(t.common.genericError, "error");
      }
      router.refresh();
    });
  };

  const send = () =>
    startSend(async () => {
      const r = await sendInvoiceAction(slug, inv.id);
      if (r.error) {
        toast(
          r.error === "no_phone"
            ? t.invoices.noPhone
            : r.error === "wa_disconnected"
              ? t.invoices.waDisconnected
              : // Not a failure to send but a refusal to send the wrong thing:
                // the PDF has no stamp on it yet.
                r.error === "einvoice_pending"
                ? t.einvoicing.pendingBlocks
                : r.error === "einvoice_failed"
                  ? t.einvoicing.failedBlocks
                  : t.common.genericError,
          "error"
        );
        // Pressing send is what queues the filing, so the page has to catch up.
        if (r.error === "einvoice_pending") router.refresh();
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
            {/* Only for a clinic that files. Everyone else's invoices sit at
                'not_required' and say nothing, exactly as before. */}
            {inv.einvoice_status !== "not_required" && (
              <Badge status={einvStatus[inv.einvoice_status] ?? "neutral"}>
                {t.einvoicing.status} ·{" "}
                {inv.einvoice_status === "submitted"
                  ? t.einvoicing.statusSubmitted
                  : inv.einvoice_status === "pending"
                    ? t.einvoicing.statusPending
                    : t.einvoicing.statusFailed}
              </Badge>
            )}
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

      {/*
        The invoice's own name, editable where it is read.

        A separate line rather than part of the header's `sub`: that is a <p>,
        and the number above it is the identifier — the title is what the clinic
        calls the work, and it is the thing most likely to need correcting after
        the fact. Blank and quiet when there is no title, which is most invoices.
      */}
      {inv.status !== "void" ? (
        <input
          className="-mt-3 mb-5 w-full max-w-lg rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-medium text-ink-700 outline-none transition-colors placeholder:font-normal placeholder:text-ink-300 hover:border-line focus:border-brand-500 focus:bg-surface"
          value={title}
          maxLength={120}
          disabled={savingTitle}
          aria-label={t.invoices.invoiceTitle}
          placeholder={t.invoices.invoiceTitlePlaceholder}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
        />
      ) : (
        inv.title && <p className="-mt-3 mb-5 text-[15px] font-medium text-ink-700">{inv.title}</p>
      )}

      {/*
        A filing that failed is the one thing on this page somebody has to act
        on, so it is said at the top with the reason and the way out — not left
        as a red chip they have to interpret.
      */}
      {inv.einvoice_status === "failed" && (
        <Card className="mb-4 !border-danger/40">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-danger">{t.einvoicing.statusFailed}</div>
              {inv.einvoice_error && (
                <p className="mt-0.5 break-words text-[13px] text-ink-500">{inv.einvoice_error}</p>
              )}
            </div>
            {/*
              Only while this invoice is still meant to be filed. Switching it off
              after a failure is a legitimate way out — the submission never
              landed, so there is nothing to correct — and leaving the button
              there would offer a retry the server is now right to refuse.
            */}
            {fileEinvoice && (
              <Button
                size="sm"
                variant="outline"
                loading={retrying}
                onClick={() =>
                  startRetry(async () => {
                    const r = await retryEinvoiceAction(slug, inv.id);
                    toast(r.error ? t.common.genericError : t.einvoicing.retried, r.error ? "error" : "success");
                    router.refresh();
                  })
                }
              >
                {t.einvoicing.retry}
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* The pair, from either end. */}
      {(inv.corrects_number || inv.credit_note_number) && (
        <p className="mb-4 rounded-lg border border-line bg-subtle px-4 py-2.5 text-[13px]">
          {inv.corrects_number ? (
            <>
              {t.einvoicing.creditNoteFor}{" "}
              <span className="font-semibold tnum" dir="ltr">{inv.corrects_number}</span>
            </>
          ) : (
            <>
              {t.einvoicing.creditNoted}{" "}
              <Link
                href={`/c/${slug}/invoices/${inv.credit_note_id}`}
                className="font-semibold text-brand-700 tnum"
                dir="ltr"
              >
                {inv.credit_note_number}
              </Link>
            </>
          )}
        </p>
      )}

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
                  {/* Only says something when there is something to say — a line
                      with no discount and the clinic's usual tax stays quiet. */}
                  <td className="w-28 px-2 py-2.5 text-end text-[12px] text-ink-500 tnum">
                    {Number(it.discount_amount) > 0 &&
                      `−${fmtMoney(Number(it.discount_amount), inv.currency, locale)} `}
                    {Number(it.tax_amount) > 0
                      ? `${Number(it.tax_rate)}%`
                      : it.tax_category !== "S"
                        ? t.invoices.taxCategories[it.tax_category as "S" | "Z" | "E" | "O"]
                        : ""}
                  </td>
                  <td className="w-32 px-5 py-2.5 text-end font-medium tnum">
                    {fmtMoney(
                      Number(it.amount) - Number(it.discount_amount) + Number(it.tax_amount),
                      inv.currency,
                      locale
                    )}
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
              {taxBreakdown(
                items.map((it) => ({
                  net: Number(it.amount) - Number(it.discount_amount),
                  tax: Number(it.tax_amount),
                  taxCategory: asTaxCategory(it.tax_category),
                  taxRate: Number(it.tax_rate),
                }))
              )
                .filter((r) => r.tax > 0)
                .map((r) => (
                  <div key={`${r.taxCategory}${r.taxRate}`} className="flex justify-between text-ink-500">
                    <span>
                      {t.invoices.tax} ({r.taxRate}%)
                    </span>
                    <span className="tnum">{fmtMoney(r.tax, inv.currency, locale)}</span>
                  </div>
                ))}
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

        {/*
          Whether the tax authority hears about this one. Only for a clinic that
          files at all — everybody else's invoices say nothing about JoFotara,
          on this page or anywhere else.
        */}
        {filesEinvoices && (
          <Card className="h-fit">
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-ink-400" />
                  {t.einvoicing.status}
                </span>
              }
            />
            <div className="flex items-start gap-3 p-5">
              <Toggle
                checked={fileEinvoice}
                disabled={filingLocked || savingFiling}
                label={t.einvoicing.fileThisInvoice}
                onChange={(v) => {
                  setFileEinvoice(v);
                  startFiling(async () => {
                    const r = await setInvoiceFilingAction(slug, inv.id, v);
                    if (r.error) {
                      setFileEinvoice(!v);
                      toast(
                        r.error === "already_filed"
                          ? t.einvoicing.alreadyFiled
                          : r.error === "einvoice_pending"
                            ? t.einvoicing.pendingBlocks
                            : t.common.genericError,
                        "error"
                      );
                      return;
                    }
                    toast(r.queued ? t.einvoicing.queuedNow : t.common.saved);
                    router.refresh();
                  });
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t.einvoicing.fileThisInvoice}</div>
                <p className="mt-0.5 text-[13px] text-ink-500">
                  {inv.einvoice_status === "submitted"
                    ? t.einvoicing.alreadyFiled
                    : inv.einvoice_status === "pending"
                      ? t.einvoicing.statusPending
                      : fileEinvoice
                        ? t.einvoicing.fileThisOnHint
                        : t.einvoicing.fileThisOffHint}
                </p>
              </div>
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
        /*
          A filed invoice cannot be deleted — ISTD has it — so cancelling raises
          a credit note against it instead. Saying that here, rather than after
          the fact, is the difference between a decision and a surprise.
        */
        body={filed ? t.einvoicing.voidReasonHint : t.invoices.voidBody}
        confirmLabel={t.invoices.voidInvoice}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          setVoidOpen(false);
          const r = await voidInvoiceAction(slug, inv.id, voidReason);
          if (r.error === "einvoice_pending") toast(t.einvoicing.pendingBlocks, "error");
          else if (r.creditNoteId) toast(t.einvoicing.creditNoteRaised);
          setVoidReason("");
          router.refresh();
        }}
      >
        {filed && (
          <Field label={t.einvoicing.voidReason}>
            <Input
              value={voidReason}
              maxLength={300}
              onChange={(e) => setVoidReason(e.target.value)}
            />
          </Field>
        )}
      </ConfirmDialog>
    </>
  );
}
