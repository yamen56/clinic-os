import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { BookingLinksClient } from "./booking-client";

export default async function BookingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const data = await inClinic(access, async (c) => {
    const links = (
      await c.query(
        `select id, name, slug, doctor_member_id, service_ids, min_notice_min, max_days_ahead,
                slot_granularity_min, approval_mode, active
         from booking_links where clinic_id = $1 order by created_at`,
        [access.clinicId]
      )
    ).rows;
    const doctors = (
      await c.query(
        `select cm.id, u.full_name as name from clinic_members cm join users u on u.id = cm.user_id
         where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active order by u.full_name`,
        [access.clinicId]
      )
    ).rows;
    const services = (
      await c.query(
        `select id, name, name_ar from services where clinic_id = $1 and active order by sort, name`,
        [access.clinicId]
      )
    ).rows;
    return { links, doctors, services };
  });

  return (
    <BookingLinksClient
      slug={slug}
      canEdit={access.role !== "doctor"}
      links={JSON.parse(JSON.stringify(data.links))}
      doctors={JSON.parse(JSON.stringify(data.doctors))}
      services={JSON.parse(JSON.stringify(data.services))}
    />
  );
}
