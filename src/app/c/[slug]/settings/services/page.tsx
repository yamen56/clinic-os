import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { ServicesClient } from "./services-client";
import { can } from "@/lib/auth";

export default async function ServicesSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  const data = await inClinic(access, async (c) => {
    const services = (
      await c.query(
        /*
          Ordered the way the screen reads: sections in the clinic's own order,
          services within each, and everything unfiled last — `false` sorts
          before `true`, so the trailing bucket falls out of the first term.
        */
        `select s.id, s.name, s.name_ar, s.duration_min, s.price, s.color, s.buffer_after_min,
                s.bookable_online, s.location_kind, s.active, s.section_id,
                coalesce(array_agg(sd.member_id) filter (where sd.member_id is not null), '{}') as doctor_ids
         from services s
         left join service_doctors sd on sd.service_id = s.id
         left join service_sections sec on sec.id = s.section_id
         where s.clinic_id = $1
         group by s.id, sec.id
         order by (s.section_id is null), sec.sort, sec.name, s.sort, s.name`,
        [access.clinicId]
      )
    ).rows;
    const sections = (
      await c.query(
        `select sec.id, sec.name, sec.name_ar, sec.color,
                count(s.id)::int as service_count
           from service_sections sec
           left join services s on s.section_id = sec.id
          where sec.clinic_id = $1
          group by sec.id
          order by sec.sort, sec.name`,
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
    return { services, doctors, sections };
  });

  return (
    <ServicesClient
      slug={slug}
      canEdit={can(access, "settings")}
      services={JSON.parse(JSON.stringify(data.services))}
      doctors={JSON.parse(JSON.stringify(data.doctors))}
      sections={JSON.parse(JSON.stringify(data.sections))}
      currency={access.clinic.currency}
    />
  );
}
