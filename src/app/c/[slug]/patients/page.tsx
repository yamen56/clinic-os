import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { patientFilterSql } from "@/lib/patients";
import { PatientsList } from "./patients-list";

export default async function PatientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    q?: string;
    tag?: string;
    source?: string;
    visit?: string;
    /** "1" — only patients muted from automations. Linked from the flows page. */
    optedOut?: string;
    new?: string;
  }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardCap(slug, "patients");

  const { where, values } = patientFilterSql(access.clinicId, sp);

  const data = await inClinic(access, async (c) => {
    const rows = (
      await c.query(
        `select p.id, p.full_name, p.phone_e164, p.tags, p.source, p.status, p.last_visit_at, p.created_at,
                p.automation_opt_out,
                (select starts_at from appointments a where a.patient_id = p.id and a.starts_at > now()
                   and a.status not in ('cancelled') order by starts_at limit 1) as next_appointment
         from patients p
         where ${where}
         order by p.updated_at desc
         limit 100`,
        values
      )
    ).rows;
    const tags = (
      await c.query(
        `select distinct unnest(tags) as tag from patients where clinic_id = $1 order by 1 limit 50`,
        [access.clinicId]
      )
    ).rows.map((r) => r.tag as string);
    const total = Number(
      (await c.query(`select count(*)::int as n from patients p where ${where}`, values)).rows[0].n
    );
    return { rows, tags, total };
  });

  return (
    <PatientsList
      slug={slug}
      total={data.total}
      patients={data.rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        phone: r.phone_e164,
        tags: r.tags,
        source: r.source,
        status: r.status,
        lastVisitAt: r.last_visit_at ? String(r.last_visit_at) : null,
        nextAppointment: r.next_appointment ? String(r.next_appointment) : null,
        mutedFromAutomations: Boolean(r.automation_opt_out),
      }))}
      allTags={data.tags}
      canExportAll={access.isOwner || access.session.user.isSuperAdmin}
      tz={access.clinic.timezone}
      initialFilters={{
        q: sp.q ?? "",
        tag: sp.tag ?? "",
        source: sp.source ?? "",
        visit: sp.visit ?? "",
        optedOut: sp.optedOut === "1" ? "1" : "",
      }}
      /* ?new=1 — what the dashboard shortcut and its keyboard accelerator open. */
      openNew={sp.new === "1"}
    />
  );
}
