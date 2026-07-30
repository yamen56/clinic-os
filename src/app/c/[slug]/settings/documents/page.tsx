import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { DocumentSettingsClient } from "./documents-client";
import { can } from "@/lib/auth";

export default async function DocumentSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);

  const data = await inClinic(access, async (c) => {
    const [templates, roles, library, clinic] = await Promise.all([
      c.query(
        `select t.id, t.name, t.name_ar, t.category, t.language, t.source, t.version, t.is_active,
                t.updated_at, t.library_key,
                (select count(*)::int from documents d where d.template_id = t.id) as used,
                coalesce((
                  select json_agg(json_build_object('id', s.id, 'name', s.name, 'nameAr', s.name_ar))
                  from service_documents sd join services s on s.id = sd.service_id
                  where sd.template_id = t.id
                ), '[]'::json) as services
         from document_templates t
         where t.clinic_id = $1
         order by t.category, t.name`,
        [access.clinicId]
      ),
      c.query(
        `select r.id, r.key, r.label, r.label_ar, r.is_staff, r.is_system, r.display_order
         from signer_roles r where r.clinic_id = $1 order by r.display_order, r.label`,
        [access.clinicId]
      ),
      // Library entries this clinic has not copied yet.
      c.query(
        `select l.key, l.name, l.name_ar, l.category from document_template_library l
         where l.active and not exists (
           select 1 from document_templates t where t.clinic_id = $1 and t.library_key = l.key
         )
         order by l.sort, l.name`,
        [access.clinicId]
      ),
      c.query(
        `select esign_link_days, esign_require_code, esign_reminder_hours from clinics where id = $1`,
        [access.clinicId]
      ),
    ]);
    return {
      templates: templates.rows,
      roles: roles.rows,
      library: library.rows,
      settings: clinic.rows[0],
    };
  });

  return (
    <DocumentSettingsClient
      slug={slug}
      isOwner={can(access, "settings.clinic")}
      templates={JSON.parse(JSON.stringify(data.templates))}
      roles={JSON.parse(JSON.stringify(data.roles))}
      library={JSON.parse(JSON.stringify(data.library))}
      settings={{
        linkDays: Number(data.settings.esign_link_days),
        requireCode: !!data.settings.esign_require_code,
        reminderHours: Number(data.settings.esign_reminder_hours),
      }}
    />
  );
}
