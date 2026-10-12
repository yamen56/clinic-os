import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { leadIdOf } from "@/lib/charts/dental/full-arch";
import { visitLines } from "@/lib/charts/dental/treatment";

type WorkRow = { markId: string; site: string; label: string; labelAr: string | null; treatmentKey: string; groupId: string | null; step: string | null; at: string };
type Member = { id: string; site: string; label: string; labelAr: string | null; treatmentKey: string; groupId: string };

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
  // Unparseable bounds would reach Postgres as a cast error: a 500, not an answer.
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return NextResponse.json({ error: "bad_range" }, { status: 400 });
  }

  /*
    A dental clinic's visit also says what was done at it: each treatment done
    there and each step of one, from the chart (0075 indexes the lookup) —
    listed below one line per treatment, as the chart lists them.
  */
  const dental = access.clinic.features.dental;
  const done = dental
    ? `,
                (select coalesce(json_agg(x order by x.at), '[]'::json) from (
                   select m.id as "markId", m.site, m.label, m.label_ar as "labelAr", m.treatment_key as "treatmentKey", m.group_id as "groupId", null::text as step, m.done_at as at
                     from chart_marks m
                    where m.appointment_id = a.id and m.voided_at is null and m.status = 'done'
                   union all
                   select m.id, m.site, m.label, m.label_ar, m.treatment_key, m.group_id, s.step, s.done_at
                     from chart_mark_steps s join chart_marks m on m.id = s.mark_id
                    where s.appointment_id = a.id and s.voided_at is null and m.voided_at is null
                 ) x) as done`
    : "";

  const data = await inClinic(access, async (c) => {
    const [appts, doctors, services, sections, clinic] = await Promise.all([
      c.query(
        `select a.id, a.patient_id, a.doctor_member_id, a.service_id, a.starts_at, a.ends_at,
                a.status, a.source, a.notes, a.intake_answers,
                p.full_name as patient_name, p.phone_e164 as patient_phone,
                s.name as service_name, s.name_ar as service_name_ar, s.color as service_color,
                s.section_id as service_section_id,
                cm.color as doctor_color, u.full_name as doctor_name,
                -- What the visit is for, when it was booked from the patient's treatment plan —
                -- while it is still to do: a treatment finished is in what was done, at its own visit.
                (select coalesce(json_agg(json_build_object('markId', m.id, 'site', m.site, 'label', m.label, 'labelAr', m.label_ar) order by m.created_at), '[]'::json)
                   from appointment_items ai join chart_marks m on m.id = ai.mark_id
                  where ai.appointment_id = a.id and m.voided_at is null and m.status = 'planned') as items${done}
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
    /*
      One line per treatment at each visit. A full arch's implants, extractions
      and bridge teeth, or a bridge's teeth, are listed under the group's lead —
      found among the group's members by the chart's own rule.
    */
    let appointments = appts.rows;
    if (dental) {
      const rows = appointments.flatMap((a) => (a.done ?? []) as WorkRow[]);
      const groups = [...new Set(rows.map((r) => r.groupId).filter((g): g is string => !!g))];
      const members: Member[] = groups.length
        ? (
            await c.query(
              `select id, site, label, label_ar as "labelAr", treatment_key as "treatmentKey", group_id as "groupId"
                 from chart_marks where clinic_id = $1 and group_id = any($2::uuid[])`,
              [access.clinicId, groups]
            )
          ).rows
        : [];
      const marks = new Map<string, { id: string; site: string; label: string; labelAr: string | null; treatmentKey: string; groupId: string | null }>();
      for (const r of rows) marks.set(r.markId, { id: r.markId, site: r.site, label: r.label, labelAr: r.labelAr, treatmentKey: r.treatmentKey, groupId: r.groupId });
      for (const m of members) marks.set(m.id, m);
      const leads = new Map(groups.map((g) => [g, leadIdOf(members.filter((m) => m.groupId === g))]));
      appointments = appointments.map((a) => (a.done ? { ...a, done: visitLines(a.done as WorkRow[], marks, (g) => leads.get(g) ?? null) } : a));
    }

    return {
      appointments,
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
