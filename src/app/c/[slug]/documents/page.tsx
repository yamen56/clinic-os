import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { loadDocumentList } from "@/lib/esign/queries";
import { DocumentsListClient } from "./documents-list";

export default async function DocumentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "documents")) redirect(`/c/${slug}`);

  /*
    Both scopes are loaded up front rather than one per visit. The tabs are the
    thing staff click most on this screen, and a `?scope=` round trip put a
    server render between the press and any visible change — on a phone that
    reads as a dead button. Two capped selects cost one extra query and buy an
    instant filter.

    Not one `all` select: it is capped too, and its ordering puts everything
    outstanding first, so a clinic with a full page of pending work would see an
    empty Completed tab.
  */
  const data = await inClinic(access, async (c) => {
    const pending = await loadDocumentList(c, access.clinicId, { scope: "pending" });
    const completed = await loadDocumentList(c, access.clinicId, { scope: "completed" });
    const templates = await c.query(
      `select id, name, name_ar, category, language from document_templates
       where clinic_id = $1 and is_active order by category, name`,
      [access.clinicId]
    );
    return { rows: [...pending, ...completed], templates: templates.rows };
  });

  return (
    <DocumentsListClient
      slug={slug}
      tz={access.clinic.timezone}
      canManage={can(access, "documents.manage")}
      rows={JSON.parse(JSON.stringify(data.rows))}
      templates={JSON.parse(JSON.stringify(data.templates))}
    />
  );
}
