import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { NewInvoiceClient } from "./new-invoice-client";
import { can } from "@/lib/auth";
import { isReady, loadEinvoiceSettings } from "@/lib/einvoice/settings";
import { loadServicesWithSections } from "@/lib/services";
import { billableMarks, chartLines, type ChartLine } from "@/lib/charts/dental/billing-server";
import { ownInvoicesOnly } from "@/lib/invoice-scope";
import { dictFor } from "@/lib/i18n/client-dict";
import { getLocale } from "@/lib/i18n";
import { billsFromCharts } from "@/lib/features";
import { visitServiceIds } from "@/lib/appointment-services";

export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ patient?: string; appointment?: string; marks?: string; from?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  if (!can(access, "invoices")) redirect(`/c/${slug}`);
  const locale = await getLocale();

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
    // A malformed id in the link is treated as no id — a blank invoice, not a crash.
    if (isUuid(sp.patient)) {
      const p = (
        await c.query(
          `select id, full_name from patients where id = $1 and clinic_id = $2 and merged_into is null`,
          [sp.patient, access.clinicId]
        )
      ).rows[0];
      if (p) patient = { id: p.id, name: p.full_name };
    }
    let appointment: { id: string; serviceId: string | null; serviceIds: string[]; doctorMemberId: string | null } | null =
      null;
    if (isUuid(sp.appointment)) {
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
        appointment = {
          id: a.id,
          serviceId: a.service_id,
          // Every service it was booked for (0106), each a line on the invoice.
          serviceIds: await visitServiceIds(c, a.id),
          doctorMemberId: a.doctor_member_id,
        };
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
    /*
      "Bill" from a patient's treatment plan: the chart work it names becomes
      the lines, priced as the plan quoted them, worded in the language the
      services list gives its lines here — the patient reads the invoice, not
      the chart's English.
    */
    let initialLines: ChartLine[] = [];
    const markIds = (sp.marks ?? "").split(",").filter((x) => isUuid(x)).slice(0, 40);
    if (patient && markIds.length && billsFromCharts(access.clinic.features)) {
      initialLines = await chartLines(c, access.clinicId, patient.id, markIds, locale, dictFor(locale).invoices.chartLine);
    }
    /*
      An invoice raised from a visit bills what was done at it. The chart says
      what that was — the treatments recorded at this appointment, or a step
      of one — so those are the lines, rather than the service it was booked
      for: booked as a check-up, the visit that ended in a filling bills the
      filling. Only work still waiting to be billed; a treatment billed whole
      at its first visit is not billed again at the second.
    */
    if (patient && appointment && !markIds.length && billsFromCharts(access.clinic.features)) {
      const own = ownInvoicesOnly(access);
      if (!own || access.memberId) {
        const waiting = await billableMarks(c, access.clinicId, patient.id, own ? access.memberId! : null);
        if (waiting.length) {
          const atVisit = (
            await c.query(
              `select l.id from chart_marks l
                where l.id = any($1::uuid[])
                  and exists (
                    select 1 from chart_marks m
                     where m.clinic_id = $2 and coalesce(m.group_id, m.id) = coalesce(l.group_id, l.id) and m.voided_at is null
                       and (m.appointment_id = $3
                            or exists (select 1 from chart_mark_steps s where s.mark_id = m.id and s.appointment_id = $3 and s.voided_at is null)))`,
              [waiting, access.clinicId, appointment.id]
            )
          ).rows.map((r) => r.id as string);
          // In the order billing would list them.
          const ids = waiting.filter((id) => atVisit.includes(id));
          if (ids.length) initialLines = await chartLines(c, access.clinicId, patient.id, ids, locale, dictFor(locale).invoices.chartLine);
        }
      }
    }
    /*
      Billed already: say so, with the invoice, before a second one is made.
      Not refused — a visit may honestly need two (a second treatment added
      later) — but never by accident from a card that did not know.
    */
    const existing = appointment
      ? ((
          await c.query(
            `select i.id, i.number from invoices i
              where i.clinic_id = $1 and i.appointment_id = $2 and i.status <> 'void' and i.credit_note_of is null
              order by i.created_at desc limit 1`,
            [access.clinicId, appointment.id]
          )
        ).rows[0] as { id: string; number: string } | undefined) ?? null
      : null;
    return { services, sections, doctors, clinic, patient, appointment, einvoice, initialLines, existing };
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
      appointmentServiceIds={data.appointment?.serviceIds}
      appointmentDoctorId={data.appointment?.doctorMemberId ?? null}
      einvoice={data.einvoice}
      initialLines={data.initialLines}
      chartBilling={billsFromCharts(access.clinic.features)}
      existingInvoice={data.existing}
      fromBoard={sp.from === "board"}
    />
  );
}
