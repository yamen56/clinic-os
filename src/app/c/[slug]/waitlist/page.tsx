import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { WaitlistClient } from "./waitlist-client";

export default async function WaitlistPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "calendar")) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const entries = (
      await c.query(
        `select w.id, w.status, w.earliest_date, w.latest_date, w.note,
                w.last_offered_at, w.offers_sent, w.created_at,
                p.id as patient_id, p.full_name, p.phone_e164,
                u.full_name as doctor_name, s.name as service_name
           from waitlist_entries w
           join patients p on p.id = w.patient_id
           left join clinic_members cm on cm.id = w.doctor_member_id
           left join users u on u.id = cm.user_id
           left join services s on s.id = w.service_id
          where w.clinic_id = $1 and w.status in ('waiting', 'offered')
          order by w.status, w.created_at`,
        [access.clinicId]
      )
    ).rows;
    const doctors = (
      await c.query(
        `select cm.id, coalesce(nullif(cm.title, ''), u.full_name) as name
           from clinic_members cm join users u on u.id = cm.user_id
          where cm.clinic_id = $1 and cm.active and cm.role = 'doctor'
          order by u.full_name`,
        [access.clinicId]
      )
    ).rows;
    const services = (
      await c.query(
        `select id, name from services where clinic_id = $1 and active order by name`,
        [access.clinicId]
      )
    ).rows;
    // Whether online booking exists at all decides if offers can be sent, and
    // saying so up front beats a waitlist that silently never messages anybody.
    const link = await c.query(
      `select 1 from booking_links where clinic_id = $1 and active limit 1`,
      [access.clinicId]
    );
    return { entries, doctors, services, hasBookingLink: !!link.rowCount };
  });

  return (
    <WaitlistClient
      slug={slug}
      tz={access.clinic.timezone}
      {...JSON.parse(JSON.stringify(data))}
    />
  );
}
