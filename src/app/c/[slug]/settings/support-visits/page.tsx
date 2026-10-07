import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { hasFullControl } from "@/lib/auth";
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
 * The owner's, and anybody the owner gave the whole clinic to. It names the
 * patients whose files the agency opened, and who was let in to look is a
 * question about the clinic as a whole rather than about any one module, so it
 * follows full control instead of a capability somebody could be handed alone.
 */
export default async function SupportVisitsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  if (!hasFullControl(access)) redirect(`/c/${slug}/settings`);

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
