import Link from "next/link";
import { guardAdmin } from "@/lib/guard";
import { getDict, getLocale } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader } from "@/components/ui/card";
import { buttonClass } from "@/components/ui/button-class";
import { loadOverview } from "@/lib/admin-overview";
import { OverviewView } from "./overview";
import { Plus } from "lucide-react";

/**
 * The agency's front page (2026-11-27): what needs somebody today and how the
 * business stands. The list of every clinic moved to /admin/clinics, one tap
 * away in the nav, so this page can answer "what do I do now" instead of
 * "here are fourteen cards".
 */
export default async function AdminOverviewPage() {
  const s = await guardAdmin();
  const [t, locale] = await Promise.all([getDict(), getLocale()]);
  const data = await withSystem((c) => loadOverview(c, { userId: s.user.id, seeAlerts: s.adminCaps.monitoring }));
  return (
    <>
      <PageHeader
        title={t.admin.overview}
        action={
          s.adminCaps["clinics.create"] ? (
            <Link href="/admin/clinics/new" className={buttonClass()}>
              <Plus className="h-4 w-4" />
              {t.admin.newClinic}
            </Link>
          ) : undefined
        }
      />
      <OverviewView data={data} t={t} locale={locale} />
    </>
  );
}
