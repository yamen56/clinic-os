"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import {
  nextInvoiceNumber,
  computeInvoice,
  refreshInvoiceStatus,
  round2,
  TAX_CATEGORIES,
  type InvoiceItemInput,
} from "@/lib/invoices";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { systemMessage } from "@/lib/system-messages";
import { emitTrigger } from "@/lib/triggers";
import { enqueueEinvoiceSubmit, requeueEinvoiceSubmit } from "@/lib/einvoice/jobs";
import { isReady, loadEinvoiceSettings } from "@/lib/einvoice/settings";
import { renderUrlToPdf } from "@/lib/pdf";
import { saveFile } from "@/lib/storage";
import { z } from "zod";

const createSchema = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().nullable().optional(),
  items: z
    .array(
      z.object({
        serviceId: z.string().uuid().nullable().optional(),
        description: z.string().min(1).max(200),
        qty: z.coerce.number().positive().max(999),
        unitPrice: z.coerce.number().min(0).max(1_000_000),
        // Per line now, not once at the bottom of the invoice — see computeInvoice.
        discountAmount: z.coerce.number().min(0).default(0),
        taxCategory: z.enum(TAX_CATEGORIES).default("S"),
        taxRate: z.coerce.number().min(0).max(100).default(0),
      })
    )
    .min(1),
  notes: z.string().max(1000).default(""),
  /*
    What the clinic calls this invoice. Optional by design — most invoices are
    one visit and the number says enough — so `default("")` rather than a
    required field with a placeholder somebody has to type past.
  */
  title: z.string().max(120).default(""),
  /*
    Whether this one goes to JoFotara. Absent means "whatever the clinic's
    default is", which is not the same as false and is why it is optional rather
    than defaulted here — the answer lives in clinic_einvoice_settings and is
    read below.
  */
  fileEinvoice: z.boolean().optional(),
});

export async function createInvoiceAction(
  slug: string,
  data: unknown
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  const parsed = createSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    const patient = (
      await c.query(`select id from patients where id = $1 and clinic_id = $2`, [
        d.patientId,
        access.clinicId,
      ])
    ).rows[0];
    if (!patient) return { error: "patient_not_found" };

    const { seq, number } = await nextInvoiceNumber(c, access.clinicId);
    const totals = computeInvoice(d.items as InvoiceItemInput[]);
    const currency = access.clinic.currency;
    // The clinic's standing answer, unless the person raising it said otherwise.
    const einv = await loadEinvoiceSettings(c, access.clinicId);
    const fileEinvoice = d.fileEinvoice ?? einv.fileByDefault;

    const inv = await c.query(
      /*
        The insurer comes off the patient's file, so an insured patient's
        invoice already knows who to claim from and reception is not asked the
        same question at every visit. The amount stays zero until somebody sets
        it: what a company will actually cover is a decision, not a default.
      */
      `insert into invoices (clinic_id, patient_id, appointment_id, seq, number, currency,
                             subtotal, discount_amount, tax_rate, tax_amount, total, notes, created_by,
                             title, file_einvoice,
                             issue_date, insurer_id, claim_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               ((now() at time zone (select timezone from clinics where id = $1)))::date,
               (select insurer_id from patients where id = $2 and clinic_id = $1),
               case when (select insurer_id from patients where id = $2 and clinic_id = $1) is null
                    then 'none' else 'to_submit' end)
       returning id`,
      [
        access.clinicId, d.patientId, d.appointmentId ?? null, seq, number, currency,
        totals.subtotal, totals.discount, totals.taxRate, totals.taxAmount, totals.total,
        d.notes, access.session.user.id, d.title.trim(), fileEinvoice,
      ]
    );
    const invoiceId = inv.rows[0].id as string;
    let sort = 0;
    for (const [i, it] of d.items.entries()) {
      // Straight from computeInvoice, so what is stored on the line is exactly
      // what the header was summed from — nothing recalculated a second way.
      const line = totals.lines[i];
      await c.query(
        `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount,
                                    discount_amount, tax_category, tax_rate, tax_amount, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          access.clinicId, invoiceId, it.serviceId ?? null, it.description,
          it.qty, it.unitPrice, line.amount,
          line.discount, line.taxCategory, line.taxRate, line.tax, sort++,
        ]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "invoice.create",
      entity: "invoice",
      entityId: invoiceId,
      detail: { number, total: totals.total, title: d.title.trim(), fileEinvoice },
    });
    revalidatePath(`/c/${slug}/invoices`);
    return { id: invoiceId };
  });
}

export async function sendInvoiceAction(slug: string, invoiceId: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };

  // Generate the PDF outside the DB transaction (Chromium visits the public page)
  const pre = await inClinic(access, async (c) => {
    const inv = (
      await c.query(
        `select i.id, i.number, i.total, i.currency, i.public_token, i.pdf_path,
                i.status, i.amount_paid, i.einvoice_status,
                p.phone_e164, p.full_name, cl.name, cl.name_ar, cl.default_locale,
                coalesce(ws.status = 'connected', false) as wa_connected
         from invoices i
         join patients p on p.id = i.patient_id
         join clinics cl on cl.id = i.clinic_id
         left join whatsapp_sessions ws on ws.clinic_id = i.clinic_id
         where i.id = $1 and i.clinic_id = $2 and i.status <> 'void'`,
        [invoiceId, access.clinicId]
      )
    ).rows[0];
    if (!inv) return null;
    /*
      Handing the invoice to the patient is the other moment it must be filed.
      Payment is the primary trigger, but a bill they take away and never settle
      would otherwise never be reported at all — and the PDF about to be sent is
      the very document that has to carry the stamp.
    */
    if (inv.einvoice_status === "not_required") {
      await enqueueEinvoiceSubmit(c, access.clinicId, invoiceId, "delivered");
      inv.einvoice_status = (
        await c.query(`select einvoice_status from invoices where id = $1`, [invoiceId])
      ).rows[0].einvoice_status;
    }
    return inv;
  });
  if (!pre) return { error: "not_found" };
  if (!pre.phone_e164) return { error: "no_phone" };
  if (!pre.wa_connected) return { error: "wa_disconnected" };
  /*
    An invoice PDF without its QR is precisely the document that is not
    compliant, so sending waits for the stamp rather than racing it. In practice
    that is a second or two; when it is longer, the clinic is told why instead of
    handing the patient something they will have to be given again.
  */
  if (pre.einvoice_status === "pending") return { error: "einvoice_pending" };
  if (pre.einvoice_status === "failed") return { error: "einvoice_failed" };

  let pdfPath = pre.pdf_path as string | null;
  try {
    const base = process.env.APP_URL || "http://localhost:3000";
    const pdf = await renderUrlToPdf(`${base}/inv/${pre.public_token}?print=1`);
    const saved = await saveFile(access.clinicId, "invoices", `${pre.number}.pdf`, pdf);
    pdfPath = saved.storagePath;
  } catch (e) {
    console.error("invoice pdf failed", e);
    if (!pdfPath) return { error: "pdf_failed" };
  }

  return inClinic(access, async (c) => {
    const base = process.env.APP_URL || "http://localhost:3000";
    const isAr = pre.default_locale !== "en";
    const clinicName = isAr ? pre.name_ar || pre.name : pre.name;
    /*
      A settled invoice is sent as proof of payment, not as a bill. Telling
      somebody who has already paid that their "total" is 100 reads as a demand
      and produces exactly the phone call this was meant to save.
    */
    const settled = pre.status === "paid";
    const body = (
      await systemMessage(c, {
        clinicId: access.clinicId,
        key: settled ? "invoice_receipt" : "invoice_sent",
        lang: isAr ? "ar" : "en",
        vars: {
          "clinic.name": clinicName,
          "invoice.number": pre.number,
          "invoice.total": `${Number(pre.total).toFixed(2)} ${pre.currency}`,
          "invoice.paid": `${Number(pre.amount_paid).toFixed(2)} ${pre.currency}`,
          "invoice.link": `${base}/inv/${pre.public_token}`,
        },
      })
    ).body;

    await queueWhatsAppMessage(c, {
      clinicId: access.clinicId,
      phoneE164: pre.phone_e164,
      senderKind: "staff",
      senderUserId: access.session.user.id,
      body,
      msgType: "document",
      mediaPath: pdfPath,
      mediaName: `${pre.number}.pdf`,
      mediaMime: "application/pdf",
    });
    await c.query(
      `update invoices set sent_at = coalesce(sent_at, now()), pdf_path = $3,
         status = case when status = 'draft' then 'sent' else status end
       where id = $1 and clinic_id = $2`,
      [invoiceId, access.clinicId, pdfPath]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "invoice.send",
      entity: "invoice",
      entityId: invoiceId,
    });
    /*
      `invoice_sent` means a bill went out, and automations hang chasing steps
      off it. Re-sending a paid invoice as a receipt must not start a chase for
      money already received — which is newly possible now that the button stays
      after payment.
    */
    if (!settled) await emitTrigger(c, access.clinicId, "invoice_sent", { invoiceId });
    revalidatePath(`/c/${slug}/invoices`);
    return {};
  });
}

export async function recordPaymentAction(
  slug: string,
  data: { invoiceId: string; amount: number; method: string; reference: string; paidAt?: string }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  if (!["cash", "cliq", "card", "transfer"].includes(data.method)) return { error: "invalid" };
  const amount = round2(Number(data.amount));
  if (!(amount > 0)) return { error: "invalid" };

  return inClinic(access, async (c) => {
    const inv = (
      await c.query(
        `select id, patient_id, total, amount_paid, status from invoices
         where id = $1 and clinic_id = $2 for update`,
        [data.invoiceId, access.clinicId]
      )
    ).rows[0];
    if (!inv || inv.status === "void") return { error: "not_found" };
    if (amount > Number(inv.total) - Number(inv.amount_paid) + 0.001) return { error: "overpay" };

    await c.query(
      `insert into payments (clinic_id, invoice_id, patient_id, amount, method, reference, paid_at, recorded_by)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), $8)`,
      [
        access.clinicId, data.invoiceId, inv.patient_id, amount, data.method,
        data.reference.slice(0, 100), data.paidAt ?? null, access.session.user.id,
      ]
    );
    await refreshInvoiceStatus(c, data.invoiceId);
    /*
      The moment the sale is real, and the moment cash-versus-receivable becomes
      knowable — which is why it is the primary trigger. It queues a job and
      returns: whether ISTD is reachable has no bearing on whether this clinic
      can take money from the person in front of them.
    */
    await enqueueEinvoiceSubmit(c, access.clinicId, data.invoiceId, "paid");
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "payment.record",
      entity: "invoice",
      entityId: data.invoiceId,
      detail: { amount, method: data.method },
    });
    revalidatePath(`/c/${slug}/invoices`);
    return {};
  });
}

/**
 * The insurance side of an invoice: who is being claimed from, how much of it
 * they cover, and where that claim has got to.
 *
 * Kept apart from the line items on purpose. The amount a company agrees to
 * cover arrives days after the work is priced, and editing the invoice to record
 * it would change what the patient was shown.
 */
export async function setInvoiceInsuranceAction(
  slug: string,
  invoiceId: string,
  data: { insurerId?: string | null; insurerAmount?: number; claimStatus?: string; claimRef?: string }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  const STATUSES = ["none", "to_submit", "submitted", "approved", "rejected", "paid"];
  if (data.claimStatus && !STATUSES.includes(data.claimStatus)) return { error: "bad_status" };

  return inClinic(access, async (c) => {
    const inv = (
      await c.query(`select total from invoices where id = $1 and clinic_id = $2`, [
        invoiceId,
        access.clinicId,
      ])
    ).rows[0];
    if (!inv) return { error: "not_found" };

    if (data.insurerId) {
      const ok = await c.query(`select 1 from insurers where id = $1 and clinic_id = $2`, [
        data.insurerId,
        access.clinicId,
      ]);
      if (!ok.rowCount) return { error: "unknown_insurer" };
    }
    // A company cannot cover more than the invoice is for; letting it would make
    // the patient's share negative and the claim unarguable.
    const amount = Math.max(0, Math.min(Number(data.insurerAmount ?? 0), Number(inv.total)));

    await c.query(
      `update invoices
          set insurer_id = coalesce($3, insurer_id),
              insurer_amount = $4,
              claim_status = coalesce($5, claim_status),
              claim_ref = coalesce($6, claim_ref),
              claim_submitted_at = case
                when $5 = 'submitted' and claim_submitted_at is null then now()
                else claim_submitted_at end
        where id = $1 and clinic_id = $2`,
      [
        invoiceId,
        access.clinicId,
        data.insurerId ?? null,
        amount,
        data.claimStatus ?? null,
        data.claimRef ?? null,
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "invoice.insurance",
      entity: "invoice",
      entityId: invoiceId,
      detail: { claimStatus: data.claimStatus, insurerAmount: amount },
    });
    revalidatePath(`/c/${slug}/invoices/${invoiceId}`);
    return {};
  });
}

/**
 * Cancelling an invoice.
 *
 * An invoice that was never filed is simply marked void, as it always was. One
 * that has been filed cannot be — a tax authority has it, and ISTD offers no
 * delete. The only way back is a credit note referencing the original, so that
 * is what this raises: a second document, mirroring the lines, filed the same
 * way. Both stay on the books, which is the point of the mechanism.
 *
 * It does not touch the payment ledger. `payments.amount > 0` forbids a negative
 * row, so a refund is a separate thing this product still does not do; saying so
 * plainly is better than a half-reversal that makes the balance lie.
 */
export async function voidInvoiceAction(
  slug: string,
  invoiceId: string,
  reason = ""
): Promise<{ error?: string; creditNoteId?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  const why = String(reason).slice(0, 300);

  return inClinic(access, async (c) => {
    const inv = (
      await c.query(
        `select * from invoices where id = $1 and clinic_id = $2 and status <> 'void' for update`,
        [invoiceId, access.clinicId]
      )
    ).rows[0];
    if (!inv) return { error: "not_found" };

    // Filed and stamped: mid-flight is not a state we can correct from, because
    // we do not yet know what ISTD has. Ask them to wait rather than raising a
    // credit note against a document that may not exist at the other end.
    if (inv.einvoice_status === "pending") return { error: "einvoice_pending" };

    await c.query(
      `update invoices set status = 'void', void_reason = $3, voided_at = now()
        where id = $1 and clinic_id = $2`,
      [invoiceId, access.clinicId, why]
    );

    let creditNoteId: string | undefined;
    if (inv.einvoice_status === "submitted") {
      const { seq, number } = await nextInvoiceNumber(c, access.clinicId);
      const note = await c.query(
        /*
          A document in its own right: its own number, its own place in the
          clinic's sequence, its own submission. `credit_note_of` is what ties
          the pair together for both the tax authority and the person reading it.
          Marked paid from the start — it settles nothing and is owed by nobody.

          `file_einvoice` is hard-coded true rather than copied from the original.
          This branch only runs when the original was submitted, and a credit
          note is the only way ISTD accepts a correction: an unfiled one would
          leave the tax authority holding a sale the clinic has cancelled.
        */
        `insert into invoices (clinic_id, patient_id, appointment_id, seq, number, currency,
                               subtotal, discount_amount, tax_rate, tax_amount, total, amount_paid,
                               notes, created_by, title, file_einvoice,
                               issue_date, credit_note_of, void_reason, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14, true,
                 ((now() at time zone (select timezone from clinics where id = $1)))::date,
                 $15, $16, 'paid')
         returning id`,
        [
          access.clinicId, inv.patient_id, inv.appointment_id, seq, number, inv.currency,
          inv.subtotal, inv.discount_amount, inv.tax_rate, inv.tax_amount, inv.total,
          inv.notes, access.session.user.id, inv.title, invoiceId, why,
        ]
      );
      creditNoteId = note.rows[0].id as string;
      await c.query(
        `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount,
                                    discount_amount, tax_category, tax_rate, tax_amount, sort)
         select clinic_id, $2, service_id, description, qty, unit_price, amount,
                discount_amount, tax_category, tax_rate, tax_amount, sort
           from invoice_items where invoice_id = $1`,
        [invoiceId, creditNoteId]
      );
      await enqueueEinvoiceSubmit(c, access.clinicId, creditNoteId, "credit_note");
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "invoice.void",
      entity: "invoice",
      entityId: invoiceId,
      detail: { reason: why, creditNoteId: creditNoteId ?? null },
    });
    revalidatePath(`/c/${slug}/invoices`);
    return { creditNoteId };
  });
}

/**
 * Renaming an invoice.
 *
 * Its own small action rather than a general invoice patch, because the title is
 * the only thing on a raised invoice that is safe to change. Every other field
 * is either money the patient has been shown or something a tax authority may
 * already hold.
 */
export async function setInvoiceTitleAction(
  slug: string,
  invoiceId: string,
  title: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  const value = String(title ?? "").trim().slice(0, 120);

  return inClinic(access, async (c) => {
    const r = await c.query(
      `update invoices set title = $3 where id = $1 and clinic_id = $2 and status <> 'void'
       returning number`,
      [invoiceId, access.clinicId, value]
    );
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "invoice.title",
      entity: "invoice",
      entityId: invoiceId,
      detail: { title: value },
    });
    revalidatePath(`/c/${slug}/invoices/${invoiceId}`);
    return {};
  });
}

/**
 * Whether this invoice goes to JoFotara, decided per invoice.
 *
 * Turning it **on** files it there and then, rather than waiting for the next
 * payment or the nightly sweep: somebody who just said "yes, report this one"
 * has asked for it to be reported, and a switch that only takes effect at 4am
 * reads as a switch that did nothing.
 *
 * Turning it **off** is only possible while ISTD has not been told. Once an
 * invoice is submitted the tax authority holds it and the way back is a credit
 * note, not a checkbox; once it is mid-flight we do not yet know which of those
 * two states we are in. A filing that failed can be switched off, because a
 * failure means nothing was recorded at the other end.
 */
export async function setInvoiceFilingAction(
  slug: string,
  invoiceId: string,
  fileIt: boolean
): Promise<{ error?: string; queued?: boolean }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const inv = (
      await c.query(
        `select id, status, einvoice_status from invoices
          where id = $1 and clinic_id = $2 for update`,
        [invoiceId, access.clinicId]
      )
    ).rows[0];
    if (!inv) return { error: "not_found" };
    if (inv.status === "void") return { error: "voided" };
    if (!fileIt && inv.einvoice_status === "submitted") return { error: "already_filed" };
    if (!fileIt && inv.einvoice_status === "pending") return { error: "einvoice_pending" };

    await c.query(`update invoices set file_einvoice = $3 where id = $1 and clinic_id = $2`, [
      invoiceId,
      access.clinicId,
      fileIt,
    ]);

    let queued = false;
    if (fileIt) {
      const settings = await loadEinvoiceSettings(c, access.clinicId);
      // A draft has not been issued yet; it is filed when it is sent or paid,
      // the same as one that was never opted out.
      if (isReady(settings) && inv.status !== "draft") {
        queued =
          inv.einvoice_status === "failed"
            ? await requeueEinvoiceSubmit(c, access.clinicId, invoiceId)
            : await enqueueEinvoiceSubmit(c, access.clinicId, invoiceId, "manual");
      }
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "invoice.filing",
      entity: "invoice",
      entityId: invoiceId,
      detail: { fileEinvoice: fileIt, queued },
    });
    revalidatePath(`/c/${slug}/invoices/${invoiceId}`);
    return { queued };
  });
}

/** Re-files an invoice whose submission failed, from the button on its page. */
export async function retryEinvoiceAction(
  slug: string,
  invoiceId: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  const ok = await inClinic(access, (c) => requeueEinvoiceSubmit(c, access.clinicId, invoiceId));
  revalidatePath(`/c/${slug}/invoices/${invoiceId}`);
  return ok ? {} : { error: "not_retryable" };
}
