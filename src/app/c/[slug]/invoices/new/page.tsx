import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { NewInvoiceClient } from "./new-invoice-client";
import { can } from "@/lib/auth";

export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ patient?: string; appointment?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  if (!can(access, "invoices")) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const services = (
      await c.query(
        `select id, name, name_ar, price from services where clinic_id = $1 and active order by sort, name`,
        [access.clinicId]
      )
    ).rows;
    const clinic = (
      await c.query(`select currency, invoice_tax_rate, invoice_tax_label from clinics where id = $1`, [
        access.clinicId,
      ])
    ).rows[0];
    let patient: { id: string; name: string } | null = null;
    if (sp.patient) {
      const p = (
        await c.query(
          `select id, full_name from patients where id = $1 and clinic_id = $2 and merged_into is null`,
          [sp.patient, access.clinicId]
        )
      ).rows[0];
      if (p) patient = { id: p.id, name: p.full_name };
    }
    let appointment: { id: string; serviceId: string | null } | null = null;
    if (sp.appointment) {
      const a = (
        await c.query(`select id, service_id from appointments where id = $1 and clinic_id = $2`, [
          sp.appointment,
          access.clinicId,
        ])
      ).rows[0];
      if (a) appointment = { id: a.id, serviceId: a.service_id };
    }
    return { services, clinic, patient, appointment };
  });

  return (
    <NewInvoiceClient
      slug={slug}
      currency={data.clinic.currency}
      defaultTaxRate={Number(data.clinic.invoice_tax_rate)}
      taxLabel={data.clinic.invoice_tax_label}
      services={JSON.parse(JSON.stringify(data.services))}
      initialPatient={data.patient}
      appointmentId={data.appointment?.id ?? null}
      appointmentServiceId={data.appointment?.serviceId ?? null}
    />
  );
}
