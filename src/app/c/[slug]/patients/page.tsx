import { guardCap } from "@/lib/guard";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import {
  patientFilterSql,
  patientListRowsSql,
  toPatientListRow,
  PATIENT_PAGE_SIZE,
} from "@/lib/patients";
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
    const rows = (await c.query(patientListRowsSql(where, null), values)).rows;

    /*
      Two round trips, not three.

      The count and the tag list used to be a query each, and node-pg serialises
      on a single client — so they were two sequential waits rather than two
      things happening at once. They answer different questions but neither
      depends on the other, so they travel together.

      The rows stay separate: merging them in would mean either json-wrapping
      every row or repeating the filter, and one extra round trip on a private
      network is not worth either.
    */
    const meta = (
      await c.query(
        `select
           (select count(*) from patients p where ${where})::int as total,
           /*
             The tag list is the filter dropdown's options, and it comes from the
             whole clinic rather than from the filtered set on purpose: the
             options must not vanish the moment one of them is chosen.
           */
           coalesce((
             select json_agg(tag order by tag)
               from (select distinct unnest(tags) as tag from patients
                      where clinic_id = $1 and merged_into is null
                      limit 50) tg
           ), '[]'::json) as tags`,
        values
      )
    ).rows[0];

    /*
      The clinic's own patient fields, for the new-patient form: what it calls
      the national number, and which fields it made required — those are asked
      when the patient is added, not left for the file.
    */
    const fields = (
      await c.query(
        `select id, key, label, label_ar, field_type, options, is_required, storage_key, source_column
           from patient_field_definitions
          where clinic_id = $1 and scope = 'patient' and not hidden and show_in_profile
          order by display_order, label`,
        [access.clinicId]
      )
    ).rows;

    return { rows, total: Number(meta.total), tags: (meta.tags ?? []) as string[], fields };
  });

  return (
    <PatientsList
      slug={slug}
      total={data.total}
      pageSize={PATIENT_PAGE_SIZE}
      patients={data.rows.map(toPatientListRow)}
      allTags={data.tags}
      fields={JSON.parse(JSON.stringify(data.fields))}
      canExportAll={can(access, "patients.export") || access.session.user.isSuperAdmin}
      canImport={can(access, "patients.import")}
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
