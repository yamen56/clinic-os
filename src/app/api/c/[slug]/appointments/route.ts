import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";

/** Calendar data: appointments in range + doctors + services + clinic hours. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar");
  if (!g.ok) return g.res;
  const access = g.access;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "missing_range" }, { status: 400 });

  const data = await inClinic(access, async (c) => {
    const [appts, doctors, services, sections, clinic] = await Promise.all([
      c.query(
        `select a.id, a.patient_id, a.doctor_member_id, a.service_id, a.starts_at, a.ends_at,
                a.status, a.source, a.notes, a.intake_answers,
                p.full_name as patient_name, p.phone_e164 as patient_phone,
                s.name as service_name, s.name_ar as service_name_ar, s.color as service_color,
                s.section_id as service_section_id,
                cm.color as doctor_color, u.full_name as doctor_name
         from appointments a
         join patients p on p.id = a.patient_id
         left join services s on s.id = a.service_id
         left join clinic_members cm on cm.id = a.doctor_member_id
         left join users u on u.id = cm.user_id
         where a.clinic_id = $1 and a.starts_at < $3 and a.ends_at > $2
         order by a.starts_at`,
        [access.clinicId, from, to]
      ),
      c.query(
        `select cm.id, cm.color, cm.title, cm.specialty, cm.working_hours, u.full_name as name
         from clinic_members cm join users u on u.id = cm.user_id
         where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active
         order by u.full_name`,
        [access.clinicId]
      ),
      c.query(
        `select s.id, s.name, s.name_ar, s.duration_min, s.price, s.color, s.buffer_after_min,
                s.bookable_online, s.active, s.section_id
         from services s
         left join service_sections sec on sec.id = s.section_id
         where s.clinic_id = $1 and s.active
         order by (s.section_id is null), sec.sort, sec.name, s.sort, s.name`,
        [access.clinicId]
      ),
      c.query(
        `select id, name, name_ar from service_sections where clinic_id = $1 order by sort, name`,
        [access.clinicId]
      ),
      c.query(`select working_hours, blocked_dates, timezone from clinics where id = $1`, [
        access.clinicId,
      ]),
    ]);
    return {
      appointments: appts.rows,
      doctors: doctors.rows,
      services: services.rows,
      sections: sections.rows,
      clinicHours: clinic.rows[0].working_hours,
      blockedDates: clinic.rows[0].blocked_dates,
      tz: clinic.rows[0].timezone,
    };
  });
  return NextResponse.json(data);
}
