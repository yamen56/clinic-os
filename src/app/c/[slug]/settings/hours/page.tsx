import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { HoursClient } from "./hours-client";
import { can } from "@/lib/auth";

export default async function HoursSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  const clinic = await inClinic(access, async (c) => {
    const r = await c.query(`select working_hours, blocked_dates from clinics where id = $1`, [
      access.clinicId,
    ]);
    return r.rows[0];
  });
  return (
    <HoursClient
      slug={slug}
      isOwner={can(access, "settings.clinic")}
      initialHours={clinic.working_hours}
      initialBlocked={clinic.blocked_dates}
    />
  );
}
