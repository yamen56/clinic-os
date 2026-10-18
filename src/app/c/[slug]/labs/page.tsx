import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { toLab, toLabCase } from "@/lib/charts/dental/labs";
import { LabsClient, type LabWork } from "./labs-client";

/*
  Lab work: what is out at the labs, what has come back, and what the clinic
  owes each outside lab.

  For whoever sends work and receives it — the doctor and the desk — and the
  money side for whoever records what the clinic spends. A dental clinic only:
  the Lab work entry appears once it keeps a lab (Settings → Dental labs).
*/
export default async function LabsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!access.clinic.features.dental || !(can(access, "patients.charts") || can(access, "invoices"))) redirect(`/c/${slug}`);
  const canPay = can(access, "expenses");

  const data = await inClinic(access, async (c) => {
    const labs = (await c.query(`select * from dental_labs where clinic_id = $1 order by active desc, sort, name`, [access.clinicId])).rows.map(toLab);
    const rows = (
      await c.query(
        `select lc.*, p.full_name as patient_name, m.label, m.site, m.treatment_key
           from lab_cases lc
           join dental_labs l on l.id = lc.lab_id
           join patients p on p.id = lc.patient_id and p.merged_into is null
           join chart_marks m on m.id = lc.mark_id
          where lc.clinic_id = $1
            and (lc.status = 'sent'
                 or (lc.status = 'received' and lc.received_at > now() - interval '30 days')
                 or ($2 and lc.status <> 'cancelled' and lc.expense_id is null and not l.in_house))
          order by lc.due_on nulls last, lc.sent_on, lc.created_at
          limit 500`,
        [access.clinicId, canPay]
      )
    ).rows;
    return {
      labs,
      work: rows.map(
        (r): LabWork => ({
          ...toLabCase(r),
          patientId: r.patient_id as string,
          patientName: r.patient_name as string,
          label: r.label as string,
          site: r.site as string,
        })
      ),
    };
  });

  return (
    <LabsClient
      slug={slug}
      currency={access.clinic.currency}
      today={DateTime.now().setZone(access.clinic.timezone).toISODate()!}
      labs={data.labs}
      work={JSON.parse(JSON.stringify(data.work))}
      canPay={canPay}
    />
  );
}
