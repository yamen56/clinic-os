import Link from "next/link";
import { guardAdmin } from "@/lib/guard";
import { withSystem } from "@/lib/db";
import { getDict, getLocale } from "@/lib/i18n";
import { storageUsageBytes } from "@/lib/storage";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LibraryEditor } from "./library-editor";
import { FileSignature, HardDrive } from "lucide-react";

/**
 * The agency's own view of signing.
 *
 * Two jobs on one page: maintain the starter library every new clinic is seeded
 * with, and see at a glance which clinics have paperwork piling up. Both are
 * agency-level questions, and splitting them across two screens would mean
 * neither gets looked at.
 */
export default async function AdminDocumentsPage() {
  await guardAdmin();
  const t = await getDict();
  const locale = await getLocale();

  const data = await withSystem(async (c) => {
    const [library, clinics] = await Promise.all([
      c.query(
        `select l.*,
                (select count(*)::int from document_templates dt where dt.library_key = l.key) as copies
         from document_template_library l order by l.sort, l.name`
      ),
      c.query(
        `select cl.id, cl.name, cl.name_ar, cl.slug,
                (select count(*)::int from documents d where d.clinic_id = cl.id
                   and d.status in ('sent', 'partially_signed')) as pending,
                (select count(*)::int from documents d where d.clinic_id = cl.id
                   and d.status = 'completed') as completed,
                (select count(*)::int from documents d where d.clinic_id = cl.id
                   and d.status = 'expired') as expired,
                (select count(*)::int from documents d where d.clinic_id = cl.id
                   and d.status = 'declined') as declined,
                (select count(*)::int from document_templates dt where dt.clinic_id = cl.id
                   and dt.is_active) as templates,
                (select coalesce(sum(length(coalesce(d.content_snapshot, ''))), 0)::bigint
                   from documents d where d.clinic_id = cl.id) as snapshot_bytes
         from clinics cl order by cl.created_at`
      ),
    ]);
    return { library: library.rows, clinics: clinics.rows };
  });

  // Storage is read from the object store (or disk), so it is fetched per clinic
  // rather than derived from the database.
  const usage = await Promise.all(
    data.clinics.map(async (cl) => ({
      id: cl.id as string,
      bytes: await storageUsageBytes(cl.id as string).catch(() => 0),
    }))
  );
  const usageById = new Map(usage.map((u) => [u.id, u.bytes]));

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="grid gap-6">
      <PageHeader title={t.settings.documentTemplates} sub={t.docTemplates.fromLibrarySub} />

      <LibraryEditor
        entries={JSON.parse(JSON.stringify(data.library))}
        locale={locale}
      />

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <FileSignature className="h-4 w-4 text-ink-400" />
              {t.docs.title}
            </span>
          }
          sub={t.admin.monitoring}
        />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-500">
                <th className="px-5 py-2.5 text-start font-semibold">{t.admin.clinics}</th>
                <th className="px-3 py-2.5 text-end font-semibold">{t.docs.tabPending}</th>
                <th className="px-3 py-2.5 text-end font-semibold">{t.docs.tabCompleted}</th>
                <th className="px-3 py-2.5 text-end font-semibold">{t.docs.statuses.expired}</th>
                <th className="px-3 py-2.5 text-end font-semibold">{t.docs.statuses.declined}</th>
                <th className="px-3 py-2.5 text-end font-semibold">{t.settings.documentTemplates}</th>
                <th className="px-5 py-2.5 text-end font-semibold">
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="h-3.5 w-3.5" />
                    {t.admin.health}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.clinics.map((cl) => (
                <tr key={cl.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-2.5">
                    <Link
                      href={`/c/${cl.slug}/documents`}
                      className="font-medium hover:text-brand-700"
                    >
                      {locale === "ar" ? cl.name_ar || cl.name : cl.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-end tnum">
                    {cl.pending > 0 ? (
                      <Badge status="pending">{cl.pending}</Badge>
                    ) : (
                      <span className="text-ink-400">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-end tnum">{cl.completed}</td>
                  <td className="px-3 py-2.5 text-end tnum">
                    {cl.expired > 0 ? (
                      <Badge status="no_show">{cl.expired}</Badge>
                    ) : (
                      <span className="text-ink-400">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-end tnum">
                    {cl.declined > 0 ? (
                      <Badge status="cancelled">{cl.declined}</Badge>
                    ) : (
                      <span className="text-ink-400">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-end tnum">{cl.templates}</td>
                  <td className="px-5 py-2.5 text-end tnum text-ink-500">
                    {mb(usageById.get(cl.id as string) ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
