import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { NewInvoiceClient } from "./new-invoice-client";
import { can } from "@/lib/auth";
import { isReady, loadEinvoiceSettings } from "@/lib/einvoice/settings";
import { loadServicesWithSections } from "@/lib/services";

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
    const { services, sections } = await loadServicesWithSections(c, access.clinicId);
    /*
      Only doctors who actually have an arrangement. A clinic that splits no
      revenue gets an empty list here and the invoice builder renders exactly as
      it did before any of this existed.

      The rate itself is deliberately not selected: the browser says who did the
      work, the server looks up what that is worth. `members_access` would have
      let this query read every rate in the clinic, and the invoice screen is
      open to any member with `invoices` — which is most of reception.
    */
    const doctors = (
      await c.query(
        `select cm.id, u.full_name
           from clinic_members cm join users u on u.id = cm.user_id
          where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active
            and cm.commission_percent is not null
          order by u.full_name`,
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
    let appointment: { id: string; serviceId: string | null; doctorMemberId: string | null } | null =
      null;
    if (sp.appointment) {
      // The doctor comes along with the service: an invoice raised from a visit
      // already knows who saw the patient, and asking reception to say so again
      // is how attribution ends up empty on most invoices.
      const a = (
        await c.query(
          `select id, service_id, doctor_member_id from appointments where id = $1 and clinic_id = $2`,
          [sp.appointment, access.clinicId]
        )
      ).rows[0];
      if (a)
        appointment = { id: a.id, serviceId: a.service_id, doctorMemberId: a.doctor_member_id };
    }
    /*
      `isReady`, not `enabled`. A clinic that ticked the switch but has not
      pasted its credentials in yet cannot file anything, so offering the choice
      would be offering a switch between two identical outcomes.
    */
    const settings = await loadEinvoiceSettings(c, access.clinicId);
    const einvoice =
      access.clinic.features.einvoicing && isReady(settings)
        ? { fileByDefault: settings.fileByDefault }
        : null;
    return { services, sections, doctors, clinic, patient, appointment, einvoice };
  });

  return (
    <NewInvoiceClient
      slug={slug}
      currency={data.clinic.currency}
      defaultTaxRate={Number(data.clinic.invoice_tax_rate)}
      taxLabel={data.clinic.invoice_tax_label}
      services={JSON.parse(JSON.stringify(data.services))}
      sections={JSON.parse(JSON.stringify(data.sections))}
      doctors={JSON.parse(JSON.stringify(data.doctors))}
      initialPatient={data.patient}
      appointmentId={data.appointment?.id ?? null}
      appointmentServiceId={data.appointment?.serviceId ?? null}
      appointmentDoctorId={data.appointment?.doctorMemberId ?? null}
      einvoice={data.einvoice}
    />
  );
}
