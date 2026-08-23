import type { PoolClient } from "pg";
import { DateTime } from "luxon";

/**
 * UBL 2.1 tax category codes, which is what an e-invoice has to carry.
 *
 * `O` is the one a clinic outside the sales-tax net uses for everything, and it
 * is not the same statement as `Z`: zero-rated means taxable at 0%, outside
 * scope means the tax does not apply to this supply at all. A tax authority
 * treats them differently, so the product has to let a clinic say which.
 */
export const TAX_CATEGORIES = ["S", "Z", "E", "O"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export function asTaxCategory(v: unknown): TaxCategory {
  return (TAX_CATEGORIES as readonly string[]).includes(v as string) ? (v as TaxCategory) : "S";
}

export type InvoiceItemInput = {
  serviceId?: string | null;
  description: string;
  qty: number;
  unitPrice: number;
  /** Absolute, in the invoice currency. Clamped to the line's own amount. */
  discountAmount?: number;
  taxCategory?: TaxCategory;
  taxRate?: number;
};

/** One line, with every number the way it will be stored and reported. */
export type ComputedLine = {
  amount: number;
  discount: number;
  net: number;
  taxCategory: TaxCategory;
  taxRate: number;
  tax: number;
};

export type InvoiceTotals = {
  lines: ComputedLine[];
  subtotal: number;
  discount: number;
  taxAmount: number;
  total: number;
  /** Kept for the header column; see the note in computeInvoice. */
  taxRate: number;
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

/**
 * Folds an invoice up from its lines.
 *
 * Every header figure is the **sum of the stored line figures**, not a separate
 * calculation over the whole. That is the difference that matters: a tax
 * authority recomputes the header from the lines it was sent, and an invoice
 * whose header was derived independently disagrees with its own lines by a fils
 * as soon as two rates or a rounded discount are involved. Round once per line,
 * then add.
 *
 * `taxRate` in the result is only for the legacy header column. It is the rate
 * when every taxed line shares one, and 0 when they do not — a single number
 * cannot describe a mixed invoice, and nothing displays from it any more.
 */
export function computeInvoice(items: InvoiceItemInput[]): InvoiceTotals {
  const lines: ComputedLine[] = items.map((it) => {
    const amount = round2(it.qty * it.unitPrice);
    const discount = Math.min(round2(Math.max(0, it.discountAmount ?? 0)), amount);
    const net = round2(amount - discount);
    const taxCategory = asTaxCategory(it.taxCategory);
    // Only a standard-rated line carries a rate. Zero-rated, exempt and
    // out-of-scope lines are 0 by definition, and letting a stray rate ride
    // along on one of them is how an exempt consultation gets taxed.
    const taxRate = taxCategory === "S" ? Math.max(0, Math.min(100, it.taxRate ?? 0)) : 0;
    const tax = round2((net * taxRate) / 100);
    return { amount, discount, net, taxCategory, taxRate, tax };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const discount = round2(lines.reduce((s, l) => s + l.discount, 0));
  const taxAmount = round2(lines.reduce((s, l) => s + l.tax, 0));
  const total = round2(subtotal - discount + taxAmount);

  const rates = [...new Set(lines.filter((l) => l.tax > 0).map((l) => l.taxRate))];
  return { lines, subtotal, discount, taxAmount, total, taxRate: rates.length === 1 ? rates[0] : 0 };
}

/** Tax broken down the way an invoice has to present it: one row per category and rate. */
export function taxBreakdown(
  lines: Pick<ComputedLine, "net" | "tax" | "taxCategory" | "taxRate">[]
): { taxCategory: TaxCategory; taxRate: number; net: number; tax: number }[] {
  const byKey = new Map<string, { taxCategory: TaxCategory; taxRate: number; net: number; tax: number }>();
  for (const l of lines) {
    const key = `${l.taxCategory}:${l.taxRate}`;
    const row = byKey.get(key) ?? { taxCategory: l.taxCategory, taxRate: l.taxRate, net: 0, tax: 0 };
    row.net = round2(row.net + l.net);
    row.tax = round2(row.tax + l.tax);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.taxRate - a.taxRate || a.taxCategory.localeCompare(b.taxCategory));
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
