"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtMoney } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Textarea, Toggle } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { computeInvoice, taxBreakdown, TAX_CATEGORIES, type TaxCategory } from "@/lib/invoices";
import { createInvoiceAction } from "../actions";
import { Plus, Trash2, X } from "lucide-react";

type Service = { id: string; name: string; name_ar: string | null; price: string };
type Item = {
  serviceId: string | null;
  description: string;
  qty: number;
  unitPrice: number;
  discountAmount: number;
  taxCategory: TaxCategory;
  taxRate: number;
};

export function NewInvoiceClient({
  slug,
  currency,
  defaultTaxRate,
  taxLabel,
  services,
  initialPatient,
  appointmentId,
  appointmentServiceId,
  einvoice,
}: {
  slug: string;
  currency: string;
  defaultTaxRate: number;
  taxLabel: string;
  services: Service[];
  initialPatient: { id: string; name: string } | null;
  appointmentId: string | null;
  appointmentServiceId: string | null;
  /**
   * Null for every clinic that does not file with JoFotara, which is most of
   * them — the switch is not rendered at all rather than rendered and disabled.
   * `fileByDefault` is the clinic's standing answer and where this form starts.
   */
  einvoice: { fileByDefault: boolean } | null;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [patient, setPatient] = useState(initialPatient);
  /*
    A clinic that charges no sales tax should never have to think about it, so a
    new line inherits the clinic's setting: a rate means standard-rated, no rate
    means outside the scope of tax. Only the mixed invoice — an exempt
    consultation beside a taxable procedure — costs anybody a click.
  */
  const newLine = (serviceId: string | null, description: string, unitPrice: number): Item => ({
    serviceId,
    description,
    qty: 1,
    unitPrice,
    discountAmount: 0,
    taxCategory: defaultTaxRate > 0 ? "S" : "O",
    taxRate: defaultTaxRate,
  });

  const [items, setItems] = useState<Item[]>(() => {
    const svc = services.find((s) => s.id === appointmentServiceId);
    return svc
      ? [newLine(svc.id, (locale === "ar" ? svc.name_ar : null) || svc.name, Number(svc.price))]
      : [];
  });
  const [notes, setNotes] = useState("");
  const [title, setTitle] = useState("");
  const [fileEinvoice, setFileEinvoice] = useState(einvoice?.fileByDefault ?? true);
  const [pending, start] = useTransition();

  /*
    The very same function the server bills with, rather than a second copy of
    the arithmetic. The preview used to be an unrounded restatement of the
    server's maths, which agreed only by luck once rounding entered.
  */
  const totals = useMemo(() => computeInvoice(items), [items]);
  const taxRows = useMemo(() => taxBreakdown(totals.lines).filter((r) => r.tax > 0), [totals]);

  const setItem = (i: number, patch: Partial<Item>) =>
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const svcName = (s: Service) => (locale === "ar" ? s.name_ar || s.name : s.name);

  const submit = () =>
    start(async () => {
      if (!patient) {
        toast(t.invoices.selectPatient, "error");
        return;
      }
      const r = await createInvoiceAction(slug, {
        patientId: patient.id,
        appointmentId,
        items,
        notes,
        title,
        // Only sent by a clinic that files. Everyone else leaves it absent and
        // the server falls back to the clinic's own default.
        ...(einvoice ? { fileEinvoice } : {}),
      });
      if (r.error || !r.id) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.invoices.created);
      router.push(`/c/${slug}/invoices/${r.id}`);
    });

  return (
    <>
      <PageHeader title={t.invoices.newInvoice} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid content-start gap-4 lg:col-span-2">
          {/* grid-cols-1, not a bare grid: an implicit column is sized `auto`,
              whose floor is its content's min-content width — the same thing
              that once pushed this page sideways on a phone. */}
          <Card className="grid grid-cols-1 gap-4 p-5">
            {/*
              Above the patient, because it is the first thing somebody raising a
              second invoice for the same person needs to tell the two apart —
              and marked optional so nobody stops to think of a name for the
              ordinary consultation that does not need one.
            */}
            <Field label={t.invoices.invoiceTitle} hint={t.common.optional}>
              <Input
                value={title}
                maxLength={120}
                placeholder={t.invoices.invoiceTitlePlaceholder}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label={t.invoices.patient} required>
              {patient ? (
                <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
                  <Avatar name={patient.name} size={28} />
                  <span className="flex-1 text-sm font-medium">{patient.name}</span>
                  <button onClick={() => setPatient(null)} aria-label={t.common.delete} className="text-ink-400 hover:text-danger">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <PatientSearch slug={slug} onPick={setPatient} />
              )}
            </Field>
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[15px] font-semibold">{t.invoices.item}</h3>
              <div className="flex flex-wrap gap-2">
                {services.slice(0, 6).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setItems((xs) => [...xs, newLine(s.id, svcName(s), Number(s.price))])}
                    className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-[12px] font-medium text-brand-700 hover:bg-brand-100"
                  >
                    + {svcName(s)}
                  </button>
                ))}
                <button
                  onClick={() => setItems((xs) => [...xs, newLine(null, "", 0)])}
                  className="flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-[12px] font-medium text-ink-500 hover:border-brand-400"
                >
                  <Plus className="h-3 w-3" />
                  {t.invoices.freeItem}
                </button>
              </div>
            </div>
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong py-8 text-center text-sm text-ink-400">
                {t.invoices.addItem}
              </p>
            ) : (
              <div className="grid gap-3">
                {items.map((it, i) => {
                  const line = totals.lines[i];
                  return (
                    <div key={i} className="grid gap-1.5 rounded-lg border border-line p-2.5">
                      <div className="grid grid-cols-[1fr_4.5rem_6rem_6rem_2rem] items-center gap-2">
                        <Input
                          value={it.description}
                          placeholder={t.invoices.item}
                          onChange={(e) => setItem(i, { description: e.target.value })}
                        />
                        {/* Labelled, because a bare number box in a row of number
                            boxes tells a screen reader nothing — and now that the
                            line carries a discount and a rate as well, position is
                            no longer enough to say which is which. */}
                        <NumberInput
                          dir="ltr" min={1}
                          aria-label={t.invoices.qty}
                          value={it.qty}
                          fallback={1}
                          onChange={(qty) => setItem(i, { qty })}
                        />
                        <NumberInput
                          dir="ltr" min={0} step="0.5"
                          aria-label={t.invoices.unitPrice}
                          value={it.unitPrice}
                          onChange={(unitPrice) => setItem(i, { unitPrice })}
                        />
                        <span className="text-end text-sm font-medium tnum">
                          {fmtMoney(line.net + line.tax, currency, locale)}
                        </span>
                        <button
                          aria-label={t.common.delete}
                          onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
                          className="text-ink-300 hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      {/*
                        The quiet row. Tax and discount belong to the line now,
                        but almost every line uses the clinic's default and
                        no discount at all — so they sit here, small, rather than
                        widening the row above past a phone.
                      */}
                      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-500">
                        <label className="flex items-center gap-1.5">
                          <span className="whitespace-nowrap">{t.invoices.discount}</span>
                          <NumberInput
                            dir="ltr" min={0} step="0.5"
                            aria-label={t.invoices.discount}
                            className="!h-8 !w-20 !text-[13px]"
                            value={it.discountAmount}
                            onChange={(discountAmount) => setItem(i, { discountAmount })}
                          />
                        </label>
                        <label className="flex items-center gap-1.5">
                          <span className="whitespace-nowrap">{t.invoices.taxCategory}</span>
                          <Select
                            className="!h-8 !w-auto !text-[13px]"
                            value={it.taxCategory}
                            onChange={(e) => {
                              const next = e.target.value as TaxCategory;
                              // A non-standard category carries no rate at all;
                              // leaving a stray one behind is how an exempt
                              // consultation quietly gets taxed.
                              setItem(i, {
                                taxCategory: next,
                                taxRate: next === "S" ? it.taxRate || defaultTaxRate : 0,
                              });
                            }}
                          >
                            {TAX_CATEGORIES.map((k) => (
                              <option key={k} value={k}>
                                {t.invoices.taxCategories[k]}
                              </option>
                            ))}
                          </Select>
                        </label>
                        {it.taxCategory === "S" && (
                          <label className="flex items-center gap-1.5">
                            <span className="whitespace-nowrap">{taxLabel || t.invoices.tax} %</span>
                            <NumberInput
                              dir="ltr" min={0} max={100} step="0.5"
                              className="!h-8 !w-20 !text-[13px]"
                              value={it.taxRate}
                              onChange={(taxRate) => setItem(i, { taxRate })}
                            />
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <Field label={t.common.notes}>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t.invoices.notesPlaceholder} />
            </Field>
          </Card>

          {/*
            Asked before the invoice exists rather than after. Filing is
            triggered by payment, and reception often takes the money in the same
            minute they raise the bill — an opt-out offered only on the finished
            invoice would frequently arrive after it had already gone to ISTD.
          */}
          {einvoice && (
            <Card className="p-5">
              <div className="flex items-start gap-3">
                <Toggle
                  checked={fileEinvoice}
                  label={t.einvoicing.fileThisInvoice}
                  onChange={setFileEinvoice}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{t.einvoicing.fileThisInvoice}</div>
                  <p className="mt-0.5 text-[13px] text-ink-500">
                    {fileEinvoice ? t.einvoicing.fileThisOnHint : t.einvoicing.fileThisOffHint}
                  </p>
                </div>
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit p-5">
          <div className="grid gap-3">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-ink-500">
                <span>{t.invoices.subtotal}</span>
                <span className="tnum">{fmtMoney(totals.subtotal, currency, locale)}</span>
              </div>
              {totals.discount > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>{t.invoices.discount}</span>
                  <span className="tnum">−{fmtMoney(totals.discount, currency, locale)}</span>
                </div>
              )}
              {/*
                One row per rate, not one row for "tax". An invoice carrying an
                exempt line beside a 16% line has to say so — a single merged
                figure is exactly the statement the clinic is not allowed to make.
              */}
              {taxRows.map((r) => (
                <div key={`${r.taxCategory}${r.taxRate}`} className="flex justify-between text-ink-500">
                  <span>
                    {taxLabel || t.invoices.tax} ({r.taxRate}%)
                  </span>
                  <span className="tnum">{fmtMoney(r.tax, currency, locale)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-line pt-2 text-base font-bold">
                <span>{t.invoices.total}</span>
                <span className="tnum">{fmtMoney(totals.total, currency, locale)}</span>
              </div>
            </div>
            <Button size="lg" onClick={submit} loading={pending} disabled={!patient || items.length === 0}>
              {t.common.create}
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}

function PatientSearch({
  slug,
  onPick,
}: {
  slug: string;
  onPick: (p: { id: string; name: string }) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string; phone_e164: string | null }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div className="grid gap-1.5">
      <Input
        value={q}
        placeholder={t.patients.searchPlaceholder}
        onChange={(e) => {
          const val = e.target.value;
          setQ(val);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(async () => {
            if (val.trim().length < 2) return setResults([]);
            const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(val)}`);
            if (res.ok) setResults((await res.json()).results ?? []);
          }, 250);
        }}
      />
      {results.map((r) => (
        <button
          key={r.id}
          onClick={() => onPick({ id: r.id, name: r.full_name })}
          className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-start text-sm hover:bg-sunken"
        >
          <Avatar name={r.full_name} size={26} />
          <span className="flex-1 font-medium">{r.full_name}</span>
          {r.phone_e164 && (
            <span className="num text-[12px] text-ink-400 tnum">{formatPhone(r.phone_e164)}</span>
          )}
        </button>
      ))}
    </div>
  );
}
