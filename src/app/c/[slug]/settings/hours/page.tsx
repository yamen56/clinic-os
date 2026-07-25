import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { HoursClient } from "./hours-client";

export default async function HoursSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const clinic = await inClinic(access, async (c) => {
    const r = await c.query(`select working_hours, blocked_dates from clinics where id = $1`, [
      access.clinicId,
    ]);
    return r.rows[0];
  });
  return (
    <HoursClient
      slug={slug}
      isOwner={access.role === "owner"}
      initialHours={clinic.working_hours}
      initialBlocked={clinic.blocked_dates}
    />
  );
}
