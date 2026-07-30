"use server";

import { revalidatePath } from "next/cache";
import { requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { nextInvoiceNumber, computeTotals, refreshInvoiceStatus, round2, type InvoiceItemInput } from "@/lib/invoices";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { emitTrigger } from "@/lib/triggers";
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
      })
    )
    .min(1),
  discountAmount: z.coerce.number().min(0).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  notes: z.string().max(1000).default(""),
});

export async function createInvoiceAction(
  slug: string,
  data: unknown
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (access.role === "doctor") return { error: "forbidden" };
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
    const totals = computeTotals(d.items as InvoiceItemInput[], d.discountAmount, d.taxRate);
    const currency = access.clinic.currency;

    const inv = await c.query(
      `insert into invoices (clinic_id, patient_id, appointment_id, seq, number, currency,
                             subtotal, discount_amount, tax_rate, tax_amount, total, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning id`,
      [
        access.clinicId, d.patientId, d.appointmentId ?? null, seq, number, currency,
        totals.subtotal, totals.discount, d.taxRate, totals.taxAmount, totals.total,
        d.notes, access.session.user.id,
      ]
    );
    const invoiceId = inv.rows[0].id as string;
    let sort = 0;
    for (const it of d.items) {
      await c.query(
        `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          access.clinicId, invoiceId, it.serviceId ?? null, it.description,
          it.qty, it.unitPrice, round2(it.qty * it.unitPrice), sort++,
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
      detail: { number, total: totals.total },
    });
    revalidatePath(`/c/${slug}/invoices`);
    return { id: invoiceId };
  });
}

export async function sendInvoiceAction(slug: string, invoiceId: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role === "doctor") return { error: "forbidden" };

  // Generate the PDF outside the DB transaction (Chromium visits the public page)
  const pre = await inClinic(access, async (c) => {
    const inv = (
      await c.query(
        `select i.id, i.number, i.total, i.currency, i.public_token, i.pdf_path,
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
    return inv ?? null;
  });
  if (!pre) return { error: "not_found" };
  if (!pre.phone_e164) return { error: "no_phone" };
  if (!pre.wa_connected) return { error: "wa_disconnected" };

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
    const body = isAr
      ? `فاتورتك من ${clinicName}\nرقم ${pre.number} — الإجمالي ${Number(pre.total).toFixed(2)} ${pre.currency}\n${base}/inv/${pre.public_token}`
      : `Your invoice from ${clinicName}\n${pre.number} — total ${Number(pre.total).toFixed(2)} ${pre.currency}\n${base}/inv/${pre.public_token}`;

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
    await emitTrigger(c, access.clinicId, "invoice_sent", { invoiceId });
    revalidatePath(`/c/${slug}/invoices`);
    return {};
  });
}

export async function recordPaymentAction(
  slug: string,
  data: { invoiceId: string; amount: number; method: string; reference: string; paidAt?: string }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role === "doctor") return { error: "forbidden" };
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

export async function voidInvoiceAction(slug: string, invoiceId: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role === "doctor") return { error: "forbidden" };
  return inClinic(access, async (c) => {
    const r = await c.query(
      `update invoices set status = 'void' where id = $1 and clinic_id = $2`,
      [invoiceId, access.clinicId]
    );
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "invoice.void",
      entity: "invoice",
      entityId: invoiceId,
    });
    revalidatePath(`/c/${slug}/invoices`);
    return {};
  });
}
