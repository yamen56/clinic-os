"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { serviceLabel, type SectionRow, type ServiceRow } from "@/lib/services";
import { ServiceAddMenu } from "@/components/ui/service-picker";
import { createInvoiceAction } from "../actions";
import { Check, Trash2, X } from "lucide-react";

type Item = {
  /**
   * The line's identity on this screen, and nowhere else — stripped before the
   * invoice is sent. Keys by position re-used one row's DOM for the next when a
   * line was deleted, which is also what would have flashed the wrong row.
   */
  uid: number;
  serviceId: string | null;
  description: string;
  qty: number;
  unitPrice: number;
  discountAmount: number;
  taxCategory: TaxCategory;
  taxRate: number;
  /** Whose work this line was. Null when the clinic splits no revenue. */
  doctorMemberId: string | null;
};
type Doctor = { id: string; full_name: string };

/** What was just added, said for a moment where the person is looking. */
type Added = { uid: number; serviceId: string | null; name: string; amount: number; at: number };

export function NewInvoiceClient({
  slug,
  currency,
  defaultTaxRate,
  taxLabel,
  services,
  sections,
  doctors,
  initialPatient,
  appointmentId,
  appointmentServiceId,
  appointmentDoctorId,
  einvoice,
}: {
  slug: string;
  currency: string;
  defaultTaxRate: number;
  taxLabel: string;
  services: ServiceRow[];
  sections: SectionRow[];
  /**
   * Doctors the clinic has a revenue share with. Empty for every clinic that
   * does not split revenue, and the whole doctor block is hidden when it is —
   * the same way sections stay invisible until somebody makes one.
   */
  doctors: Doctor[];
  initialPatient: { id: string; name: string } | null;
  appointmentId: string | null;
  appointmentServiceId: string | null;
  appointmentDoctorId: string | null;
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
    The doctor a new line starts on: whoever the visit was with. An invoice
    raised from an appointment already knows who saw the patient, and asking
    reception to say so again is how attribution ends up empty on most invoices.
  */
  const startingDoctor = doctors.some((d) => d.id === appointmentDoctorId)
    ? appointmentDoctorId
    : null;
  const [invoiceDoctor, setInvoiceDoctor] = useState<string | null>(startingDoctor);
  const nextUid = useRef(1);
  const money = (n: number) => fmtMoney(n, currency, locale);

  /*
    A clinic that charges no sales tax should never have to think about it, so a
    new line inherits the clinic's setting: a rate means standard-rated, no rate
    means outside the scope of tax. Only the mixed invoice — an exempt
    consultation beside a taxable procedure — costs anybody a click.
  */
  const newLine = (
    serviceId: string | null,
    description: string,
    unitPrice: number,
    doctorMemberId: string | null = invoiceDoctor
  ): Item => ({
    uid: nextUid.current++,
    serviceId,
    description,
    qty: 1,
    unitPrice,
    discountAmount: 0,
    taxCategory: defaultTaxRate > 0 ? "S" : "O",
    taxRate: defaultTaxRate,
    doctorMemberId,
  });

  const [items, setItems] = useState<Item[]>(() => {
    const svc = services.find((s) => s.id === appointmentServiceId);
    return svc ? [newLine(svc.id, serviceLabel(svc, locale), Number(svc.price), startingDoctor)] : [];
  });
  const [notes, setNotes] = useState("");
  const [title, setTitle] = useState("");
  const [fileEinvoice, setFileEinvoice] = useState(einvoice?.fileByDefault ?? true);
  const [added, setAdded] = useState<Added | null>(null);
  const [pending, start] = useTransition();

  // The note fades on its own; a second tap replaces it and restarts the clock.
  useEffect(() => {
    if (!added) return;
    const timer = setTimeout(() => setAdded(null), 2600);
    return () => clearTimeout(timer);
  }, [added]);

  /*
    The very same function the server bills with, rather than a second copy of
    the arithmetic. The preview used to be an unrounded restatement of the
    server's maths, which agreed only by luck once rounding entered.
  */
  const totals = useMemo(() => computeInvoice(items), [items]);
  const taxRows = useMemo(() => taxBreakdown(totals.lines).filter((r) => r.tax > 0), [totals]);
  const taxTotal = taxRows.reduce((sum, r) => sum + r.tax, 0);
  const addedCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const it of items) if (it.serviceId) out[it.serviceId] = (out[it.serviceId] ?? 0) + 1;
    return out;
  }, [items]);
  /*
    A line with no name is refused by the server, and used to come back as
    "something went wrong" with nothing to say which line. The button waits
    instead, and the empty box says it is the one.
  */
  const unnamed = items.some((it) => !it.description.trim());

  const setItem = (uid: number, patch: Partial<Item>) =>
    setItems((xs) => xs.map((x) => (x.uid === uid ? { ...x, ...patch } : x)));

  const addService = (s: ServiceRow) => {
    const line = newLine(s.id, serviceLabel(s, locale), Number(s.price));
    setItems((xs) => [...xs, line]);
    /*
      The service's own price, the figure printed beside it in the list a moment
      ago — not what the line adds with tax, which reads as a different price
      for the thing just tapped. The tax is said under the total instead.
    */
    setAdded({ uid: line.uid, serviceId: s.id, name: line.description, amount: line.unitPrice, at: Date.now() });
  };

  const submit = () =>
    start(async () => {
      if (!patient) {
        toast(t.invoices.selectPatient, "error");
        return;
      }
      const r = await createInvoiceAction(slug, {
        patientId: patient.id,
        appointmentId,
        items: items.map(({ uid: _uid, ...line }) => line),
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="grid content-start gap-4 lg:col-span-2">
          {/* grid-cols-1, not a bare grid: an implicit column is sized `auto`,
              whose floor is its content's min-content width — the same thing
              that once pushed this page sideways on a phone. */}
          <Card className="grid grid-cols-1 gap-4 p-4 sm:p-5">
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
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{patient.name}</span>
                  <button
                    onClick={() => setPatient(null)}
                    aria-label={t.common.delete}
                    className="grid h-8 w-8 shrink-0 touch-manipulation place-items-center rounded-full text-ink-400 hover:bg-danger-soft hover:text-danger"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <PatientSearch slug={slug} onPick={setPatient} />
              )}
            </Field>
          </Card>

          <Card className="grid grid-cols-1 gap-3 p-4 sm:p-5">
            <h3 className="text-[15px] font-semibold">{t.invoices.item}</h3>
            {/*
              Every service, grouped by section and searchable — not the first
              six. The old row of chips was capped at six with no way past it,
              so on a clinic with more services the seventh could only be typed
              by hand, which drops `service_id` and takes that money out of the
              revenue-by-service and revenue-by-section charts.
            */}
            <ServiceAddMenu
              services={services}
              sections={sections}
              currency={currency}
              addedCounts={addedCounts}
              flash={added?.serviceId ? { serviceId: added.serviceId, key: added.at } : null}
              onPick={addService}
              onCustom={() => setItems((xs) => [...xs, newLine(null, "", 0)])}
            />
            {/*
              Who the clinic owes for this visit. One control for the whole
              invoice, because an invoice is usually one doctor's work; the
              per-line override sits on each row below for the visit that was
              not. Hidden entirely when no doctor has an arrangement.

              The percentage is never shown here and never sent: this picker
              says who, and the server decides what that is worth.
            */}
            {doctors.length > 0 && (
              <Field label={t.invoices.doctor} hint={t.invoices.doctorHint}>
                <Select
                  value={invoiceDoctor ?? ""}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setInvoiceDoctor(v);
                    setItems((xs) => xs.map((x) => ({ ...x, doctorMemberId: v })));
                  }}
                >
                  <option value="">{t.invoices.noDoctor}</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.full_name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-4 py-7 text-center text-sm text-ink-400">
                {t.invoices.pickServiceHint}
              </p>
            ) : (
              <div className="grid gap-2.5">
                {items.map((it, i) => {
                  const line = totals.lines[i];
                  const nameless = !it.description.trim();
                  return (
                    <div
                      key={it.uid}
                      className={`grid min-w-0 gap-2.5 rounded-xl border border-line p-3 ${
                        added?.uid === it.uid ? "animate-line-in" : ""
                      }`}
                    >
                      {/*
                        Two rows on every screen, not one. Description, quantity,
                        price, total and a bin across one row were five fixed
                        columns — about 330px before the description got any —
                        inside a 300px card on a phone, so the description was
                        squeezed to an empty box and the row ran out of its card.
                      */}
                      <div className="flex items-start gap-2">
                        <Input
                          value={it.description}
                          placeholder={t.invoices.item}
                          aria-invalid={nameless || undefined}
                          // Amber, not red: a custom line is born empty, and
                          // the box is asking for a name rather than reporting a fault.
                          className={`min-w-0 flex-1 font-medium ${nameless ? "!border-st-pending" : ""}`}
                          onChange={(e) => setItem(it.uid, { description: e.target.value })}
                        />
                        <button
                          type="button"
                          aria-label={t.common.delete}
                          onClick={() => setItems((xs) => xs.filter((x) => x.uid !== it.uid))}
                          className="grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-ctl text-ink-400 transition-colors hover:bg-danger-soft hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[5rem_8rem_1fr]">
                        {/* Labelled, because a bare number box in a row of number
                            boxes tells a screen reader nothing — and now that the
                            line carries a discount and a rate as well, position is
                            no longer enough to say which is which. */}
                        <label className="grid min-w-0 gap-1">
                          <span className="text-[11px] font-medium text-ink-500">{t.invoices.qty}</span>
                          <NumberInput
                            dir="ltr" min={1}
                            aria-label={t.invoices.qty}
                            value={it.qty}
                            fallback={1}
                            onChange={(qty) => setItem(it.uid, { qty })}
                          />
                        </label>
                        <label className="grid min-w-0 gap-1">
                          <span className="text-[11px] font-medium text-ink-500">{t.invoices.unitPrice}</span>
                          <NumberInput
                            dir="ltr" min={0} step="0.5"
                            aria-label={t.invoices.unitPrice}
                            value={it.unitPrice}
                            onChange={(unitPrice) => setItem(it.uid, { unitPrice })}
                          />
                        </label>
                        <div className="grid gap-1 text-end">
                          <span className="text-[11px] font-medium text-ink-500">{t.invoices.lineTotal}</span>
                          <span className="flex h-10 items-center justify-end whitespace-nowrap text-[15px] font-semibold tnum">
                            {money(line.net + line.tax)}
                          </span>
                        </div>
                      </div>
                      {/*
                        The quiet row. Tax and discount belong to the line now,
                        but almost every line uses the clinic's default and
                        no discount at all — so they sit here, small. Three to a
                        row on a phone, where wrapped at their natural widths
                        they fell into ragged lines of one and two.
                      */}
                      <div className="grid grid-cols-3 gap-2 border-t border-line pt-2.5 text-[12px] text-ink-500 sm:flex sm:flex-wrap sm:items-end">
                        <label className="grid min-w-0 gap-1">
                          <span className="truncate">{t.invoices.discount}</span>
                          <NumberInput
                            dir="ltr" min={0} step="0.5"
                            aria-label={t.invoices.discount}
                            className="!h-8 !text-[13px] sm:!w-24"
                            value={it.discountAmount}
                            onChange={(discountAmount) => setItem(it.uid, { discountAmount })}
                          />
                        </label>
                        <label className="grid min-w-0 gap-1">
                          <span className="truncate">{t.invoices.taxCategory}</span>
                          <Select
                            className="!h-8 !text-[13px] sm:!w-auto"
                            value={it.taxCategory}
                            onChange={(e) => {
                              const next = e.target.value as TaxCategory;
                              // A non-standard category carries no rate at all;
                              // leaving a stray one behind is how an exempt
                              // consultation quietly gets taxed.
                              setItem(it.uid, {
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
                          <label className="grid min-w-0 gap-1">
                            <span className="truncate">{taxLabel || t.invoices.tax} %</span>
                            <NumberInput
                              dir="ltr" min={0} max={100} step="0.5"
                              className="!h-8 !text-[13px] sm:!w-20"
                              value={it.taxRate}
                              onChange={(taxRate) => setItem(it.uid, { taxRate })}
                            />
                          </label>
                        )}
                        {/*
                          The override, for the visit two doctors worked on. It
                          sits in the quiet row beside the other two per-line
                          exceptions, because that is what it is: the control
                          above sets every line, and almost every invoice leaves
                          this alone.
                        */}
                        {doctors.length > 1 && (
                          <label className="col-span-3 grid min-w-0 gap-1 sm:col-span-1">
                            <span className="truncate">{t.invoices.doctor}</span>
                            <Select
                              className="!h-8 !text-[13px] sm:!w-auto"
                              aria-label={t.invoices.doctor}
                              value={it.doctorMemberId ?? ""}
                              onChange={(e) =>
                                setItem(it.uid, { doctorMemberId: e.target.value || null })
                              }
                            >
                              <option value="">{t.invoices.noDoctor}</option>
                              {doctors.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.full_name}
                                </option>
                              ))}
                            </Select>
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-4 sm:p-5">
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
            <Card className="p-4 sm:p-5">
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

        {/*
          The total, always in view. Beside the form on a wide screen; below it,
          pinned above the tab bar as the page scrolls. It used to sit at the
          very bottom of a phone's page, so adding a service changed nothing on
          screen — the line went in below the fold and so did the new total —
          and a tap that answers with nothing reads as a tap that missed.

          One element at every size rather than a bar plus a card, so there is
          only ever one Create button: two, one of them hidden, is a control a
          keyboard or a screen reader can land on and not see.
        */}
        <div className="z-20 max-lg:sticky max-lg:bottom-[calc(4.25rem_+_env(safe-area-inset-bottom))] md:max-lg:bottom-4 lg:sticky lg:top-6 lg:self-start">
          <Card className="p-3.5 max-lg:shadow-pop sm:p-5">
            {added && (
              <div
                role="status"
                className="mb-2.5 flex items-center gap-2 rounded-lg bg-st-confirmed-soft px-2.5 py-1.5 text-[12.5px] font-medium text-st-confirmed animate-fade-up"
              >
                <Check className="h-4 w-4 shrink-0" strokeWidth={2.5} />
                <span className="min-w-0 truncate">
                  {t.invoices.addedLine.replace("{name}", added.name).replace("{price}", money(added.amount))}
                </span>
              </div>
            )}
            {/* The breakdown, where there is room for it. */}
            <div className="hidden space-y-1.5 text-sm lg:block">
              <div className="flex justify-between text-ink-500">
                <span>{t.invoices.subtotal}</span>
                <span className="tnum">{money(totals.subtotal)}</span>
              </div>
              {totals.discount > 0 && (
                <div className="flex justify-between text-ink-500">
                  <span>{t.invoices.discount}</span>
                  <span className="tnum">−{money(totals.discount)}</span>
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
                  <span className="tnum">{money(r.tax)}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 lg:mt-2 lg:grid lg:gap-3 lg:border-t lg:border-line lg:pt-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="hidden text-base font-bold lg:inline">{t.invoices.total}</span>
                  <span
                    // Keyed on the last add, so the figure re-enters as it changes.
                    key={added?.at ?? 0}
                    className="font-display text-xl font-bold tnum animate-fade-in lg:text-base"
                  >
                    {money(totals.total)}
                  </span>
                </div>
                {/* What a phone does not show above: how many lines, and the tax in it. */}
                <div className="truncate text-[11.5px] text-ink-500 lg:hidden">
                  {t.invoices.lineCount.replace("{n}", String(items.length))}
                  {taxTotal > 0 &&
                    ` · ${t.invoices.includesTax
                      .replace("{label}", taxLabel || t.invoices.tax)
                      .replace("{amount}", money(taxTotal))}`}
                </div>
              </div>
              <Button
                size="lg"
                className="max-lg:px-7 lg:w-full"
                onClick={submit}
                loading={pending}
                disabled={!patient || items.length === 0 || unnamed}
              >
                {t.common.create}
              </Button>
            </div>
            {unnamed && <p className="mt-2 text-[12px] font-medium text-st-pending">{t.invoices.nameEveryLine}</p>}
          </Card>
        </div>
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
          className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 text-start text-sm hover:bg-sunken"
        >
          <Avatar name={r.full_name} size={26} />
          <span className="min-w-0 flex-1 truncate font-medium">{r.full_name}</span>
          {r.phone_e164 && (
            <span className="num shrink-0 text-[12px] text-ink-400 tnum">{formatPhone(r.phone_e164)}</span>
          )}
        </button>
      ))}
    </div>
  );
}
