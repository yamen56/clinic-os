import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { withSystem } from "./db";
import { registerJobHandler, type JobAttempt } from "./jobs";
import { notifyClinicStaff } from "../src/lib/notify";
import { asTaxCategory, round2 } from "../src/lib/invoices";
import { isReady, loadEinvoiceSettings } from "../src/lib/einvoice/settings";
import { logEinvoiceEvent } from "../src/lib/einvoice/jobs";
import { submitInvoice } from "../src/lib/einvoice/submit";
import { insurerShareOf, patientShareLines } from "../src/lib/einvoice/share";
import {
  buildInvoiceXml,
  encodeInvoice,
  DOC_INVOICE,
  DOC_CREDIT_NOTE,
  type EinvoiceLine,
} from "../src/lib/einvoice/ubl";

/**
 * Filing an invoice with ISTD.
 *
 * Runs as a job, never inside a request, for the reason every integration with
 * somebody else's server runs as a job: it can be slow and it can be down, and
 * neither of those may stop a clinic taking money from a patient standing at
 * the desk. The invoice is already raised and already paid by the time this
 * runs; what is at stake here is the stamp, not the sale.
 */

type Ctx = {
  invoice: Record<string, unknown>;
  lines: EinvoiceLine[];
  settings: Awaited<ReturnType<typeof loadEinvoiceSettings>>;
  slug: string;
  correctsNumber: string | null;
  /** The insurer's share left off this document; see src/lib/einvoice/share.ts. */
  excluded: number;
};

/**
 * Re-reads everything, and decides whether there is still work to do.
 *
 * Every handler in this worker starts by re-reading its subject, because by the
 * time a retry runs the world has moved: the invoice may have been voided, or
 * another attempt may already have succeeded, or the clinic may have switched
 * the module off. Returning null is the ordinary case, not an error.
 */
async function load(invoiceId: string): Promise<Ctx | null> {
  return withSystem(async (c) => {
    const inv = (
      await c.query(
        `select i.*, cl.slug, cl.timezone,
                p.full_name as patient_name, p.phone_e164 as patient_phone,
                orig.number as corrects_number, orig.einvoice_excluded as corrects_excluded
           from invoices i
           join clinics cl on cl.id = i.clinic_id
           join patients p on p.id = i.patient_id
           left join invoices orig on orig.id = i.credit_note_of
          where i.id = $1`,
        [invoiceId]
      )
    ).rows[0];
    if (!inv) return null;
    if (inv.einvoice_status !== "pending") return null;

    const settings = await loadEinvoiceSettings(c, inv.clinic_id as string);
    if (!isReady(settings)) {
      /*
        Switched off, or the credentials were removed, between queueing and now.
        Put the invoice back rather than failing it: nothing went wrong, this
        clinic simply does not file any more, and a red error on the invoice
        would be a lie about what happened.
      */
      await c.query(
        `update invoices set einvoice_status = 'not_required' where id = $1 and einvoice_status = 'pending'`,
        [invoiceId]
      );
      return null;
    }

    /*
      The UUID is ours and is written before the first send, so every retry
      carries the same one. That is what makes a retry safe at ISTD's end too:
      a document they have already accepted arrives with an identifier they
      recognise instead of looking like a second sale.
    */
    if (!inv.einvoice_uuid) {
      inv.einvoice_uuid = randomUUID();
      await c.query(`update invoices set einvoice_uuid = $2 where id = $1`, [
        invoiceId,
        inv.einvoice_uuid,
      ]);
    }

    const rows = (
      await c.query(
        `select description, qty, unit_price, amount, discount_amount, tax_category, tax_rate, tax_amount
           from invoice_items where invoice_id = $1 order by sort`,
        [invoiceId]
      )
    ).rows;

    const lines: EinvoiceLine[] = rows.map((r) => ({
      description: String(r.description),
      qty: Number(r.qty),
      unitPrice: Number(r.unit_price),
      amount: Number(r.amount),
      discount: Number(r.discount_amount),
      taxCategory: asTaxCategory(r.tax_category),
      taxRate: Number(r.tax_rate),
      tax: Number(r.tax_amount),
    }));

    /*
      A credit note reverses the document that was filed, so it leaves off what
      that filing left off — read from the original's record of it, not from the
      insurer amount as it stands now. Null there means a filing from before the
      split existed, which left nothing off.
    */
    const excluded = inv.credit_note_of
      ? round2(Number(inv.corrects_excluded ?? 0))
      : insurerShareOf(Number(inv.total), inv.insurer_amount);

    return {
      invoice: inv,
      lines,
      settings,
      slug: String(inv.slug),
      correctsNumber: (inv.corrects_number as string) ?? null,
      excluded,
    };
  });
}

export async function submitEinvoice(invoiceId: string, attempt: JobAttempt): Promise<void> {
  const ctx = await load(invoiceId);
  if (!ctx) return;
  const { invoice: inv, settings, excluded } = ctx;
  const clinicId = String(inv.clinic_id);

  const isCreditNote = Boolean(inv.credit_note_of);
  const lines = patientShareLines(ctx.lines, excluded);
  if (!lines.length) {
    /*
      The insurer covers all of it: there is no sale to the patient to report.
      Normally caught before queueing (enqueueEinvoiceSubmit); this is the
      belt for an amount that reached the full total some other way.
    */
    await withSystem(async (c) => {
      await c.query(
        `update invoices set einvoice_status = 'not_required', einvoice_excluded = $2
          where id = $1 and einvoice_status = 'pending'`,
        [invoiceId, excluded]
      );
      await logEinvoiceEvent(c, clinicId, invoiceId, "skipped", { excluded });
    });
    return;
  }
  // What the patient owes, which is what this document is for.
  const share = round2(Number(inv.total) - excluded);
  const paid = Number(inv.amount_paid) >= share && share > 0;
  const issueDate = inv.issue_date
    ? DateTime.fromJSDate(new Date(inv.issue_date as string)).toFormat("yyyy-MM-dd")
    : DateTime.now().setZone(String(inv.timezone)).toFormat("yyyy-MM-dd");

  const xml = buildInvoiceXml({
    settings,
    uuid: String(inv.einvoice_uuid),
    number: String(inv.number),
    icv: Number(inv.seq),
    issueDate,
    currency: String(inv.currency),
    documentType: isCreditNote ? DOC_CREDIT_NOTE : DOC_INVOICE,
    /*
      Cash or receivable. A credit note reverses a sale rather than making one,
      and is reported the way the invoice it corrects was — which for a clinic
      is almost always cash, money already taken at the desk.
    */
    paid: isCreditNote ? true : paid,
    buyerName: String(inv.patient_name ?? ""),
    buyerPhone: (inv.patient_phone as string) ?? null,
    buyerTaxNumber: null,
    lines,
    correctsNumber: ctx.correctsNumber,
    correctionReason: (inv.void_reason as string) || null,
  });

  const result = await submitInvoice({ settings, payload: encodeInvoice(xml) });

  if (result.ok) {
    await withSystem(async (c) => {
      await c.query(
        /*
          `pdf_path = null` on purpose. Any PDF rendered before the stamp arrived
          has no QR square on it, and the download route serves a cached file
          whenever one exists — so the cache is dropped here rather than being
          second-guessed there. The next download re-renders, once.
        */
        `update invoices set einvoice_status = 'submitted', einvoice_qr = $2, einvoice_number = $3,
                             einvoice_type = $4, einvoice_payment_method = $5,
                             einvoice_submitted_at = now(), einvoice_error = null,
                             einvoice_excluded = $6, pdf_path = null
          where id = $1`,
        [
          invoiceId,
          result.qr,
          result.number,
          isCreditNote ? DOC_CREDIT_NOTE : DOC_INVOICE,
          // The sub-type digits carry cash/receivable; this column records the
          // plain fact so a person reading the invoice does not have to decode it.
          isCreditNote || paid ? "012" : "022",
          excluded,
        ]
      );
      await c.query(
        `update clinic_einvoice_settings set last_ok_at = now(), last_error = null where clinic_id = $1`,
        [clinicId]
      );
      await logEinvoiceEvent(c, clinicId, invoiceId, "accepted", {
        qr: Boolean(result.qr),
        number: result.number,
        ...(excluded > 0 ? { excluded, filed: share } : {}),
      });
    });
    if (!result.qr) {
      /*
        Accepted, but nothing came back to print. Worth saying out loud rather
        than swallowing: the QR is the visible half of compliance, and its
        absence almost certainly means the response field names moved — the one
        part of this integration not confirmed against ISTD's own document.
      */
      console.warn(`[einvoice] ${inv.number}: accepted with no QR in the response`);
    }
    return;
  }

  /*
    A 4xx is the invoice, not the weather: it will be rejected identically five
    more times. Only a timeout, a 5xx or a rate limit earns the runner's backoff,
    and even then only until the attempts run out — after that somebody has to
    be told, because an invoice stuck pending forever is indistinguishable from
    one nobody looked at.
  */
  const keepTrying = result.retryable && !attempt.isLastAttempt;

  await withSystem(async (c) => {
    await logEinvoiceEvent(c, clinicId, invoiceId, result.retryable ? "error" : "rejected", {
      status: result.status,
      error: result.error,
      attempt: attempt.attempts,
      willRetry: keepTrying,
    });
    if (!keepTrying) {
      await c.query(
        `update invoices set einvoice_status = 'failed', einvoice_error = $2 where id = $1`,
        [invoiceId, result.error]
      );
      await c.query(
        `update clinic_einvoice_settings set last_error = $2 where clinic_id = $1`,
        [clinicId, result.error]
      );
      await notifyClinicStaff(c, clinicId, {
        kind: "einvoice_failed",
        title: `تعذّر إرسال الفاتورة ${inv.number} إلى فوترة`,
        body: result.error,
        url: `/c/${ctx.slug}/invoices/${invoiceId}`,
        roles: ["owner", "receptionist"],
        // One alert per invoice, not one per attempt.
        dedupeKey: `einvoice_failed:${invoiceId}`,
      });
    }
  });

  // Thrown only when a retry is actually wanted; the runner does the backoff.
  if (keepTrying) throw new Error(`jofotara: ${result.error}`);
}

export function registerEinvoiceJobs(): void {
  registerJobHandler("einvoice:submit", async (payload, _clinicId, attempt) => {
    await submitEinvoice(String(payload.invoiceId), attempt);
  });
}
