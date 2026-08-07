import { notFound, redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { InvoiceDetailClient } from "./invoice-detail-client";
import { can } from "@/lib/auth";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "invoices")) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const inv = (
      await c.query(
        `select i.*, p.full_name as patient_name, p.phone_e164 as patient_phone,
                cl.timezone, cl.currency as clinic_currency,
                ins.name as insurer_name,
                coalesce(ws.status = 'connected', false) as wa_connected
         from invoices i
         join patients p on p.id = i.patient_id
         join clinics cl on cl.id = i.clinic_id
         left join insurers ins on ins.id = i.insurer_id
         left join whatsapp_sessions ws on ws.clinic_id = i.clinic_id
         where i.id = $1 and i.clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!inv) return null;
    const items = (
      await c.query(
        `select description, qty, unit_price, amount from invoice_items where invoice_id = $1 order by sort`,
        [id]
      )
    ).rows;
    const payments = (
      await c.query(
        `select pay.id, pay.amount, pay.method, pay.reference, pay.paid_at, u.full_name as recorded_by
         from payments pay left join users u on u.id = pay.recorded_by
         where pay.invoice_id = $1 order by pay.paid_at desc`,
        [id]
      )
    ).rows;
    const insurers = (
      await c.query(
        `select id, name from insurers where clinic_id = $1 and active order by name`,
        [access.clinicId]
      )
    ).rows;
    return { inv, items, payments, insurers };
  });
  if (!data) notFound();

  return (
    <InvoiceDetailClient
      slug={slug}
      invoice={JSON.parse(JSON.stringify(data.inv))}
      items={JSON.parse(JSON.stringify(data.items))}
      payments={JSON.parse(JSON.stringify(data.payments))}
      insurers={JSON.parse(JSON.stringify(data.insurers))}
    />
  );
}
