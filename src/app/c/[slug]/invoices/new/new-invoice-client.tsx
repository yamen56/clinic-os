"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtMoney } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { createInvoiceAction } from "../actions";
import { Plus, Trash2, X } from "lucide-react";

type Service = { id: string; name: string; name_ar: string | null; price: string };
type Item = { serviceId: string | null; description: string; qty: number; unitPrice: number };

export function NewInvoiceClient({
  slug,
  currency,
  defaultTaxRate,
  taxLabel,
  services,
  initialPatient,
  appointmentId,
  appointmentServiceId,
}: {
  slug: string;
  currency: string;
  defaultTaxRate: number;
  taxLabel: string;
  services: Service[];
  initialPatient: { id: string; name: string } | null;
  appointmentId: string | null;
  appointmentServiceId: string | null;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [patient, setPatient] = useState(initialPatient);
  const [items, setItems] = useState<Item[]>(() => {
    const svc = services.find((s) => s.id === appointmentServiceId);
    return svc
      ? [{ serviceId: svc.id, description: (locale === "ar" ? svc.name_ar : null) || svc.name, qty: 1, unitPrice: Number(svc.price) }]
      : [];
  });
  const [discount, setDiscount] = useState(0);
  const [taxRate, setTaxRate] = useState(defaultTaxRate);
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();

  const totals = useMemo(() => {
    const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
    const disc = Math.min(discount, subtotal);
    const tax = ((subtotal - disc) * taxRate) / 100;
    return { subtotal, disc, tax, total: subtotal - disc + tax };
  }, [items, discount, taxRate]);

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
        discountAmount: discount,
        taxRate,
        notes,
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
          <Card className="p-5">
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
                    onClick={() =>
                      setItems((xs) => [
                        ...xs,
                        { serviceId: s.id, description: svcName(s), qty: 1, unitPrice: Number(s.price) },
                      ])
                    }
                    className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-[12px] font-medium text-brand-700 hover:bg-brand-100"
                  >
                    + {svcName(s)}
                  </button>
                ))}
                <button
                  onClick={() => setItems((xs) => [...xs, { serviceId: null, description: "", qty: 1, unitPrice: 0 }])}
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
              <div className="grid gap-2">
                {items.map((it, i) => (
                  <div key={i} className="grid grid-cols-[1fr_4.5rem_6rem_6rem_2rem] items-center gap-2">
                    <Input
                      value={it.description}
                      placeholder={t.invoices.item}
                      onChange={(e) =>
                        setItems((xs) => xs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                      }
                    />
                    <Input
                      type="number" dir="ltr" min={1}
                      value={it.qty}
                      onChange={(e) =>
                        setItems((xs) => xs.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) || 1 } : x)))
                      }
                    />
                    <Input
                      type="number" dir="ltr" min={0} step="0.5"
                      value={it.unitPrice}
                      onChange={(e) =>
                        setItems((xs) => xs.map((x, j) => (j === i ? { ...x, unitPrice: Number(e.target.value) || 0 } : x)))
                      }
                    />
                    <span className="text-end text-sm font-medium tnum">
                      {fmtMoney(it.qty * it.unitPrice, currency, locale)}
                    </span>
                    <button
                      aria-label={t.common.delete}
                      onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
                      className="text-ink-300 hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <Field label={t.common.notes}>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t.invoices.notesPlaceholder} />
            </Field>
          </Card>
        </div>

        <Card className="h-fit p-5">
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={`${t.invoices.discount} (${currency})`}>
                <Input type="number" dir="ltr" min={0} step="0.5" value={discount}
                  onChange={(e) => setDiscount(Number(e.target.value) || 0)} />
              </Field>
              <Field label={`${taxLabel || t.invoices.tax} %`}>
                <Input type="number" dir="ltr" min={0} max={100} step="0.5" value={taxRate}
                  onChange={(e) => setTaxRate(Number(e.target.value) || 0)} />
              </Field>
            </div>
            <div className="space-y-1.5 border-t border-line pt-3 text-sm">
              <div className="flex justify-between text-ink-500">
                <span>{t.invoices.subtotal}</span>
                <span className="tnum">{fmtMoney(totals.subtotal, currency, locale)}</span>
              </div>
              {totals.disc > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>{t.invoices.discount}</span>
                  <span className="tnum">−{fmtMoney(totals.disc, currency, locale)}</span>
                </div>
              )}
              {totals.tax > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>{taxLabel || t.invoices.tax}</span>
                  <span className="tnum">{fmtMoney(totals.tax, currency, locale)}</span>
                </div>
              )}
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
