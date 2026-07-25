"use client";

import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { SaveIndicator } from "@/components/ui/save-indicator";

export function InvoicingForm({
  slug,
  isOwner,
  clinic,
}: {
  slug: string;
  isOwner: boolean;
  clinic: {
    invoice_prefix: string;
    invoice_counter: number;
    invoice_tax_rate: string;
    invoice_tax_label: string;
    invoice_footer: string;
    payment_instructions: string;
    currency: string;
  };
}) {
  const { t } = useI18n();
  const { patch, state } = useAutosave({ url: `/api/c/${slug}/clinic`, entityKey: `invset:${slug}` });
  const ro = !isOwner;

  return (
    <Card>
      <CardHeader title={t.settings.invoiceSettings} action={<SaveIndicator state={state} />} />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label={`${t.invoices.invoiceNo} · Prefix`} hint={`${clinic.invoice_prefix}-2026-${String(clinic.invoice_counter + 1).padStart(4, "0")}`}>
          <Input dir="ltr" defaultValue={clinic.invoice_prefix} disabled={ro}
            onChange={(e) => patch({ invoice_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) })} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={`${t.invoices.tax} %`}>
            <Input dir="ltr" type="number" min={0} max={100} step="0.5" defaultValue={Number(clinic.invoice_tax_rate)} disabled={ro}
              onChange={(e) => patch({ invoice_tax_rate: Number(e.target.value) || 0 })} />
          </Field>
          <Field label={t.invoices.tax}>
            <Input defaultValue={clinic.invoice_tax_label} disabled={ro} placeholder="VAT / ضريبة"
              onChange={(e) => patch({ invoice_tax_label: e.target.value })} />
          </Field>
        </div>
        <Field label={t.invoices.paymentInstructions} hint="CliQ / bank details">
          <Textarea defaultValue={clinic.payment_instructions} disabled={ro} className="min-h-24"
            onChange={(e) => patch({ payment_instructions: e.target.value })} />
        </Field>
        <Field label="Footer">
          <Textarea defaultValue={clinic.invoice_footer} disabled={ro} className="min-h-24"
            onChange={(e) => patch({ invoice_footer: e.target.value })} />
        </Field>
      </div>
    </Card>
  );
}
