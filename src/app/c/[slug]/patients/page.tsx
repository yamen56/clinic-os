import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { patientSearchClause } from "@/lib/patients";
import { PatientsList } from "./patients-list";

export default async function PatientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; tag?: string; source?: string; visit?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);

  const data = await inClinic(access, async (c) => {
    const conds: string[] = ["p.clinic_id = $1", "p.merged_into is null", "p.status <> 'archived'"];
    const vals: unknown[] = [access.clinicId];
    if (sp.q?.trim()) {
      const { clause, params: ps } = patientSearchClause(sp.q, vals.length + 1);
      conds.push(clause);
      vals.push(...ps);
    }
    if (sp.tag) {
      vals.push(sp.tag);
      conds.push(`$${vals.length} = any(p.tags)`);
    }
    if (sp.source) {
      vals.push(sp.source);
      conds.push(`p.source = $${vals.length}`);
    }
    if (sp.visit === "30" || sp.visit === "90" || sp.visit === "180") {
      conds.push(
        `(p.last_visit_at is null or p.last_visit_at < now() - interval '${Number(sp.visit)} days')`
      );
    }
    const rows = (
      await c.query(
        `select p.id, p.full_name, p.phone_e164, p.tags, p.source, p.status, p.last_visit_at, p.created_at,
                (select starts_at from appointments a where a.patient_id = p.id and a.starts_at > now()
                   and a.status not in ('cancelled') order by starts_at limit 1) as next_appointment
         from patients p
         where ${conds.join(" and ")}
         order by p.updated_at desc
         limit 100`,
        vals
      )
    ).rows;
    const tags = (
      await c.query(
        `select distinct unnest(tags) as tag from patients where clinic_id = $1 order by 1 limit 50`,
        [access.clinicId]
      )
    ).rows.map((r) => r.tag as string);
    const total = Number(
      (await c.query(`select count(*)::int as n from patients p where ${conds.join(" and ")}`, vals))
        .rows[0].n
    );
    const tz = (await c.query(`select timezone from clinics where id = $1`, [access.clinicId]))
      .rows[0].timezone as string;
    return { rows, tags, tz, total };
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
      }))}
      allTags={data.tags}
      tz={data.tz}
      initialFilters={{ q: sp.q ?? "", tag: sp.tag ?? "", source: sp.source ?? "", visit: sp.visit ?? "" }}
    />
  );
}
