import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadServicesWithSections } from "@/lib/services";
import { RoomsClient } from "./rooms-client";

export default async function RoomsSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.services");

  const data = await inClinic(access, async (c) => {
    const rooms = (
      await c.query(
        `select r.id, r.name, r.name_ar, r.color,
                coalesce((select array_agg(rs.service_id::text) from clinic_room_services rs where rs.room_id = r.id), '{}') as service_ids
           from clinic_rooms r
          where r.clinic_id = $1 and r.active
          order by r.sort, r.name`,
        [access.clinicId]
      )
    ).rows;
    const doctors = (
      await c.query(
        `select cm.id, cm.color, cm.default_room_id, u.full_name as name
           from clinic_members cm join users u on u.id = cm.user_id
          where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active
          order by u.full_name`,
        [access.clinicId]
      )
    ).rows;
    const { services, sections } = await loadServicesWithSections(c, access.clinicId);
    const inPerson = (
      await c.query(
        `select id from services where clinic_id = $1 and active and coalesce(location_kind, 'in_person') <> 'online'`,
        [access.clinicId]
      )
    ).rows.map((r) => r.id as string);
    // Booked before rooms existed: blocks nothing until it is placed.
    const unroomed = rooms.length
      ? ((
          await c.query(
            `select count(*)::int as n from appointments a left join services s on s.id = a.service_id
              where a.clinic_id = $1 and a.room_id is null and a.starts_at > now()
                and a.status in ('pending_approval', 'scheduled', 'confirmed')
                and coalesce(s.location_kind, 'in_person') <> 'online'`,
            [access.clinicId]
          )
        ).rows[0].n as number)
      : 0;
    return { rooms, doctors, services, sections, inPerson, unroomed };
  });

  return <RoomsClient slug={slug} {...JSON.parse(JSON.stringify(data))} />;
}
