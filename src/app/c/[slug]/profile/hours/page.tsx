import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/card";
import type { WeeklyHours } from "@/lib/hours";
import { MyHoursClient } from "./my-hours-client";

/**
 * A doctor's own working hours.
 *
 * Under the profile rather than Settings for the same reason the profile exists:
 * Settings needs a capability most doctors do not have, and a doctor's hours are
 * theirs to keep. A support visit has no membership, so it has nothing to edit.
 */
export default async function MyHoursPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (access.role !== "doctor" || !access.memberId) redirect(`/c/${slug}/profile`);
  const t = await dictForClinic(access.clinic.vocabulary);

  const row = await inClinic(access, async (c) => {
    const r = await c.query(
      `select cm.working_hours, cl.working_hours as clinic_hours
         from clinic_members cm join clinics cl on cl.id = cm.clinic_id
        where cm.id = $1 and cm.clinic_id = $2`,
      [access.memberId, access.clinicId]
    );
    return r.rows[0] as { working_hours: WeeklyHours | null; clinic_hours: WeeklyHours };
  });

  return (
    <>
      <PageHeader title={t.myHours.title} sub={t.myHours.sub} />
      <MyHoursClient
        slug={slug}
        tz={access.clinic.timezone}
        clinicHours={row.clinic_hours}
        initialHours={row.working_hours && Object.keys(row.working_hours).length ? row.working_hours : null}
      />
    </>
  );
}
