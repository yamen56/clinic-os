import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { ServicesClient } from "./services-client";

export default async function ServicesSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const data = await inClinic(access, async (c) => {
    const services = (
      await c.query(
        `select s.id, s.name, s.name_ar, s.duration_min, s.price, s.color, s.buffer_after_min,
                s.bookable_online, s.active,
                coalesce(array_agg(sd.member_id) filter (where sd.member_id is not null), '{}') as doctor_ids
         from services s
         left join service_doctors sd on sd.service_id = s.id
         where s.clinic_id = $1
         group by s.id
         order by s.sort, s.name`,
        [access.clinicId]
      )
    ).rows;
    const doctors = (
      await c.query(
        `select cm.id, u.full_name as name from clinic_members cm
         join users u on u.id = cm.user_id
         where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active
         order by u.full_name`,
        [access.clinicId]
      )
    ).rows;
    const currency = (
      await c.query(`select currency from clinics where id = $1`, [access.clinicId])
    ).rows[0].currency;
    return { services, doctors, currency };
  });

  return (
    <ServicesClient
      slug={slug}
      canEdit={access.role !== "doctor"}
      services={JSON.parse(JSON.stringify(data.services))}
      doctors={JSON.parse(JSON.stringify(data.doctors))}
      currency={data.currency}
    />
  );
}
