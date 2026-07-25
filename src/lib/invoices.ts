import type { PoolClient } from "pg";
import { DateTime } from "luxon";

export type InvoiceItemInput = {
  serviceId?: string | null;
  description: string;
  qty: number;
  unitPrice: number;
};

/** Atomic per-clinic sequence: never repeats, never visibly skips. */
export async function nextInvoiceNumber(
  c: PoolClient,
  clinicId: string
): Promise<{ seq: number; number: string }> {
  const r = await c.query(
    `update clinics set invoice_counter = invoice_counter + 1
     where id = $1
     returning invoice_counter, invoice_prefix, timezone`,
    [clinicId]
  );
  const { invoice_counter, invoice_prefix, timezone } = r.rows[0];
  const year = DateTime.now().setZone(timezone).year;
  return {
    seq: invoice_counter,
    number: `${invoice_prefix}-${year}-${String(invoice_counter).padStart(4, "0")}`,
  };
}

export function computeTotals(
  items: InvoiceItemInput[],
  discountAmount: number,
  taxRate: number
): { subtotal: number; discount: number; taxAmount: number; total: number } {
  const subtotal = round2(items.reduce((s, it) => s + it.qty * it.unitPrice, 0));
  const discount = Math.min(round2(discountAmount), subtotal);
  const taxable = subtotal - discount;
  const taxAmount = round2((taxable * taxRate) / 100);
  return { subtotal, discount, taxAmount, total: round2(taxable + taxAmount) };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Recomputes amount_paid + status after any payment change. */
export async function refreshInvoiceStatus(c: PoolClient, invoiceId: string): Promise<void> {
  await c.query(
    `update invoices i set
       amount_paid = coalesce((select sum(amount) from payments p where p.invoice_id = i.id), 0),
       status = case
         when i.status = 'void' then 'void'
         when coalesce((select sum(amount) from payments p where p.invoice_id = i.id), 0) >= i.total and i.total > 0 then 'paid'
         when coalesce((select sum(amount) from payments p where p.invoice_id = i.id), 0) > 0 then 'partially_paid'
         when i.sent_at is not null then 'sent'
         else i.status
       end
     where i.id = $1`,
    [invoiceId]
  );
}
