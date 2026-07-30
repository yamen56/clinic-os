import { notFound } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadFieldDefinitions } from "@/lib/esign/fields";
import { TemplateEditor } from "./template-editor";

export default async function TemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const { slug, id } = await params;
  const { source } = await searchParams;
  const access = await guardClinic(slug);
  const isNew = id === "new";

  const data = await inClinic(access, async (c) => {
    const [defs, roles, services] = await Promise.all([
      loadFieldDefinitions(c, access.clinicId),
      c.query(
        `select key, label, label_ar, is_staff from signer_roles
         where clinic_id = $1 order by display_order, label`,
        [access.clinicId]
      ),
      c.query(
        `select id, name, name_ar from services where clinic_id = $1 and active order by sort, name`,
        [access.clinicId]
      ),
    ]);

    if (isNew) {
      return { defs, roles: roles.rows, services: services.rows, template: null, versions: [], fields: [] };
    }

    const template = (
      await c.query(`select * from document_templates where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ])
    ).rows[0];
    if (!template) return null;

    const [versions, attached, fields] = await Promise.all([
      c.query(
        `select version, name, created_at, u.full_name as author
         from document_template_versions v left join users u on u.id = v.created_by
         where v.template_id = $1 order by version desc limit 20`,
        [id]
      ),
      c.query(
        `select service_id, auto_send from service_documents where template_id = $1 and clinic_id = $2`,
        [id, access.clinicId]
      ),
      c.query(
        `select id, page_number, x, y, width, height, field_type, assigned_role_key,
                is_required, label, prefilled_value, sort
         from document_fields where template_id = $1 order by page_number, sort`,
        [id]
      ),
    ]);

    return {
      defs,
      roles: roles.rows,
      services: services.rows,
      template: {
        ...template,
        serviceIds: attached.rows.map((r) => r.service_id as string),
        autoSend: attached.rows.length ? !!attached.rows[0].auto_send : true,
      },
      versions: versions.rows,
      fields: fields.rows,
    };
  });

  if (!data) notFound();

  return (
    <TemplateEditor
      slug={slug}
      isOwner={access.role === "owner"}
      defaultSource={source === "upload" ? "upload" : "template"}
      defs={JSON.parse(JSON.stringify(data.defs))}
      roles={JSON.parse(JSON.stringify(data.roles))}
      services={JSON.parse(JSON.stringify(data.services))}
      template={data.template ? JSON.parse(JSON.stringify(data.template)) : null}
      versions={JSON.parse(JSON.stringify(data.versions))}
      placedFields={JSON.parse(JSON.stringify(data.fields))}
    />
  );
}
