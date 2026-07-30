import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadDocumentList } from "@/lib/esign/queries";
import { DocumentsListClient } from "./documents-list";

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const { slug } = await params;
  const { scope } = await searchParams;
  const access = await guardClinic(slug);
  const view = scope === "completed" ? "completed" : scope === "all" ? "all" : "pending";

  const data = await inClinic(access, async (c) => {
    const [rows, templates, counts] = await Promise.all([
      loadDocumentList(c, access.clinicId, { scope: view }),
      c.query(
        `select id, name, name_ar, category, language from document_templates
         where clinic_id = $1 and is_active order by category, name`,
        [access.clinicId]
      ),
      c.query(
        `select
           count(*) filter (where status in ('draft', 'sent', 'partially_signed'))::int as pending,
           count(*) filter (where status = 'completed')::int as completed,
           count(*)::int as all
         from documents where clinic_id = $1`,
        [access.clinicId]
      ),
    ]);
    return { rows, templates: templates.rows, counts: counts.rows[0] };
  });

  return (
    <DocumentsListClient
      slug={slug}
      tz={access.clinic.timezone}
      role={access.role}
      scope={view}
      rows={JSON.parse(JSON.stringify(data.rows))}
      templates={JSON.parse(JSON.stringify(data.templates))}
      counts={{
        pending: Number(data.counts.pending),
        completed: Number(data.counts.completed),
        all: Number(data.counts.all),
      }}
    />
  );
}
