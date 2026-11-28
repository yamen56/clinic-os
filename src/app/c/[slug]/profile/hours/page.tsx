import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/card";
import { clinicNow } from "@/lib/dates";
import type { WeeklyHours } from "@/lib/hours";
import { loadUpcomingTimeOff } from "@/lib/time-off";
import { MyHoursClient } from "./my-hours-client";
import { DaysOffCard } from "../../settings/hours/days-off-card";

/**
 * A doctor's own working hours, and their days off.
 *
 * Under the profile rather than Settings for the same reason the profile exists:
 * Settings needs a capability most doctors do not have, and a doctor's hours are
 * theirs to keep. A support visit has no membership, so it has nothing to edit.
 */
export default async function MyHoursPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (access.role !== "doctor" || !access.memberId) redirect(`/c/${slug}/profile`);
  const memberId = access.memberId;
  const t = await dictForClinic(access.clinic.vocabulary);
  const tz = access.clinic.timezone;
  const today = clinicNow(tz).toISODate()!;

  const { row, timeOff } = await inClinic(access, async (c) => {
    const r = await c.query(
      `select cm.working_hours, cl.working_hours as clinic_hours
         from clinic_members cm join clinics cl on cl.id = cm.clinic_id
        where cm.id = $1 and cm.clinic_id = $2`,
      [memberId, access.clinicId]
    );
    return {
      row: r.rows[0] as { working_hours: WeeklyHours | null; clinic_hours: WeeklyHours },
      timeOff: await loadUpcomingTimeOff(c, access.clinicId, today, memberId),
    };
  });

  return (
    <>
      <PageHeader title={t.myHours.title} sub={t.myHours.sub} />
      <div className="grid grid-cols-1 gap-4">
        <MyHoursClient
          slug={slug}
          tz={tz}
          clinicHours={row.clinic_hours}
          initialHours={row.working_hours && Object.keys(row.working_hours).length ? row.working_hours : null}
        />
        <DaysOffCard
          slug={slug}
          tz={tz}
          today={today}
          doctors={[{ id: memberId, name: access.session.user.fullName }]}
          initialRows={timeOff}
        />
      </div>
    </>
  );
}
