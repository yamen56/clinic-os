import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { HoursClient } from "./hours-client";
import { DaysOffCard } from "./days-off-card";
import { can } from "@/lib/auth";
import { clinicNow } from "@/lib/dates";
import { loadUpcomingTimeOff } from "@/lib/time-off";

export default async function HoursSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  const tz = access.clinic.timezone;
  const today = clinicNow(tz).toISODate()!;
  // One connection, so one statement after another: the clinic, its doctors, their days off.
  const data = await inClinic(access, async (c) => {
    const clinic = (
      await c.query(`select working_hours, blocked_dates from clinics where id = $1`, [access.clinicId])
    ).rows[0];
    const doctors = (
      await c.query(
        `select m.id, u.full_name as name from clinic_members m join users u on u.id = m.user_id
          where m.clinic_id = $1 and m.active and m.role = 'doctor' order by u.full_name`,
        [access.clinicId]
      )
    ).rows as { id: string; name: string }[];
    const timeOff = await loadUpcomingTimeOff(c, access.clinicId, today);
    return { clinic, doctors, timeOff };
  });
  return (
    <div className="grid grid-cols-1 gap-4">
      <HoursClient
        slug={slug}
        isOwner={can(access, "settings.clinic")}
        initialHours={data.clinic.working_hours}
        initialBlocked={data.clinic.blocked_dates}
      />
      <DaysOffCard slug={slug} tz={tz} today={today} doctors={data.doctors} initialRows={data.timeOff} />
    </div>
  );
}
