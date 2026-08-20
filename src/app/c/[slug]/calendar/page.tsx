import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { CalendarClient } from "./calendar-client";

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ patient?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardCap(slug, "calendar");

  const data = await inClinic(access, async (c) => {
    let initialPatient: { id: string; name: string } | null = null;
    if (sp.patient) {
      const p = (
        await c.query(
          `select id, full_name from patients where id = $1 and clinic_id = $2 and merged_into is null`,
          [sp.patient, access.clinicId]
        )
      ).rows[0];
      if (p) initialPatient = { id: p.id, name: p.full_name };
    }
    return { initialPatient };
  });

  return (
    <CalendarClient
      slug={slug}
      tz={access.clinic.timezone}
      isDoctor={access.role === "doctor"}
      selfMemberId={access.memberId}
      initialPatient={data.initialPatient}
    />
  );
}
