import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { listSupportVisits } from "@/lib/support-visits";
import { SupportVisitList } from "@/components/support-visit-list";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { ShieldCheck } from "lucide-react";

/**
 * When the Clinicti team was inside this clinic, and what they did there.
 *
 * Behind its own switch, `settings.support_visits`: the owner and anybody on
 * full access hold it, and an owner can tick it for one more person on the
 * access editor. It names the patients whose files the agency opened, so it is
 * never part of a job's defaults.
 */
export default async function SupportVisitsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.support_visits");

  const [t, locale] = await Promise.all([dictForClinic(access.clinic.vocabulary), getLocale()]);
  const visits = await inClinic(access, (c) =>
    listSupportVisits(c, { clinicId: access.clinicId }, { limit: 100, withPatients: true })
  );

  return (
    <Card>
      <CardHeader title={t.supportVisits.title} sub={t.supportVisits.sub} />
      {visits.length === 0 ? (
        <EmptyState bare icon={<ShieldCheck />} title={t.supportVisits.empty} />
      ) : (
        <SupportVisitList
          visits={visits}
          t={t}
          locale={locale}
          patientHref={(id) => `/c/${slug}/patients/${id}`}
        />
      )}
    </Card>
  );
}
