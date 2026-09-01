import type { PoolClient } from "pg";
import { isReady, loadEinvoiceSettings } from "./settings";

/**
 * Handing an invoice to the tax authority.
 *
 * Three different moments can decide an invoice needs filing — it was paid, it
 * was delivered, or a sweep noticed it had been neither for a day — and they
 * all call the one function below. The dedupe key is what makes that safe: the
 * first of them wins, the rest insert nothing, and an invoice is submitted once
 * however many times it is asked for.
 *
 * Never in the path of taking money. `recordPaymentAction` inserts a row here
 * and returns; whether ISTD is reachable is the worker's problem, and a clinic
 * must always be able to charge a patient standing at the desk.
 */

export type SubmitReason = "paid" | "delivered" | "sweep" | "manual" | "credit_note";

/**
 * Queues one invoice for submission, if this clinic files at all.
 *
 * Returns whether anything was queued, so a caller that needs the stamp before
 * it can proceed — sending the PDF to the patient — can tell the difference
 * between "on its way" and "this clinic does not do this".
 */
export async function enqueueEinvoiceSubmit(
  c: PoolClient,
  clinicId: string,
  invoiceId: string,
  reason: SubmitReason
): Promise<boolean> {
  const settings = await loadEinvoiceSettings(c, clinicId);
  /*
    `isReady`, not `enabled`. A clinic that ticked the switch but has not pasted
    its credentials yet would otherwise queue every invoice into a submission
    that cannot possibly succeed, and meet the problem as a wall of failed jobs
    instead of an empty field on a form.
  */
  if (!isReady(settings)) return false;

  const marked = await c.query(
    /*
      Only an invoice that has never been filed. A submitted one must not be
      sent again — ISTD would treat the second document as a second sale — and a
      failed one is picked up by an explicit retry rather than by whoever next
      happens to open the invoice.

      `file_einvoice` is the clinic's answer for this one invoice, and it is
      checked here rather than at each of the four call sites: payment, delivery
      and the nightly sweep all arrive through this function, so one condition
      is the difference between an opt-out that holds and three that mostly do.
      Turning the flag back on is what queues it, via setInvoiceFilingAction.
    */
    `update invoices set einvoice_status = 'pending'
      where id = $1 and clinic_id = $2 and einvoice_status = 'not_required'
        and file_einvoice and status <> 'void'
      returning id`,
    [invoiceId, clinicId]
  );
  if (!marked.rowCount) return false;

  await c.query(
    `insert into jobs (clinic_id, kind, payload, dedupe_key)
     values ($1, 'einvoice:submit', $2, $3)
     on conflict (dedupe_key) do nothing`,
    [clinicId, JSON.stringify({ invoiceId, reason }), `einvoice:submit:${invoiceId}`]
  );
  await logEinvoiceEvent(c, clinicId, invoiceId, "queued", { reason });
  return true;
}

/**
 * Re-files an invoice whose submission failed.
 *
 * A separate door from the one above because it has to clear the dedupe key: a
 * failed job leaves its row behind, and without removing it the retry would be
 * swallowed by `on conflict do nothing` and look like a button that does not work.
 */
export async function requeueEinvoiceSubmit(
  c: PoolClient,
  clinicId: string,
  invoiceId: string
): Promise<boolean> {
  const settings = await loadEinvoiceSettings(c, clinicId);
  if (!isReady(settings)) return false;

  const marked = await c.query(
    `update invoices set einvoice_status = 'pending', einvoice_error = null
      where id = $1 and clinic_id = $2 and einvoice_status = 'failed' and file_einvoice
      returning id`,
    [invoiceId, clinicId]
  );
  if (!marked.rowCount) return false;

  await c.query(`delete from jobs where dedupe_key = $1`, [`einvoice:submit:${invoiceId}`]);
  await c.query(
    `insert into jobs (clinic_id, kind, payload, dedupe_key)
     values ($1, 'einvoice:submit', $2, $3)
     on conflict (dedupe_key) do nothing`,
    [clinicId, JSON.stringify({ invoiceId, reason: "manual" }), `einvoice:submit:${invoiceId}`]
  );
  await logEinvoiceEvent(c, clinicId, invoiceId, "queued", { reason: "manual" });
  return true;
}

export async function logEinvoiceEvent(
  c: PoolClient,
  clinicId: string,
  invoiceId: string,
  kind: "queued" | "submitted" | "accepted" | "rejected" | "error",
  detail: Record<string, unknown> = {}
): Promise<void> {
  await c.query(
    `insert into invoice_einvoice_events (clinic_id, invoice_id, kind, detail)
     values ($1, $2, $3, $4)`,
    [clinicId, invoiceId, kind, JSON.stringify(detail)]
  );
}
