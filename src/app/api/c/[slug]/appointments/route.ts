import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { invoiceScopeSql } from "@/lib/invoice-scope";
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
                    where m.appointment_id = a.id and m.chart = 'dental' and m.voided_at is null and m.status = 'done'
                   union all
                   select m.id, m.site, m.label, m.label_ar, m.treatment_key, m.group_id, s.step, s.done_at
                     from chart_mark_steps s join chart_marks m on m.id = s.mark_id
                    where s.appointment_id = a.id and s.voided_at is null and m.voided_at is null and m.chart = 'dental'
                 ) x) as done`
    : "";

  /*
    One after another, not Promise.all: node-pg runs one query at a time per
    connection, so "parallel" on one client was a queue with a warning.
  */
  const data = await inClinic(access, async (c) => {
    const appts = await c.query(
        `select a.id, a.patient_id, a.doctor_member_id, a.service_id, a.starts_at, a.ends_at,
                a.status, a.source, a.notes, a.intake_answers,
                a.room_id, a.arrived_at, a.seated_at, a.finished_at, a.walk_in, a.flow_prev_status,
                p.full_name as patient_name, p.phone_e164 as patient_phone,
                s.name as service_name, s.name_ar as service_name_ar, s.color as service_color,
                s.section_id as service_section_id, s.location_kind as service_location,
                cm.color as doctor_color, u.full_name as doctor_name,
                rm.name as room_name, rm.name_ar as room_name_ar, rm.color as room_color,
                -- Never seen before this visit: reception greets a first visit differently.
                not exists (select 1 from appointments a2
                             where a2.patient_id = a.patient_id and a2.status = 'completed' and a2.starts_at < a.starts_at) as first_visit,
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
         left join clinic_rooms rm on rm.id = a.room_id
         where a.clinic_id = $1 and a.starts_at < $3 and a.ends_at > $2
         order by a.starts_at`,
        [access.clinicId, from, to]
      );
    const doctors = await c.query(
        `select cm.id, cm.color, cm.title, cm.specialty, cm.working_hours, cm.default_room_id, u.full_name as name
         from clinic_members cm join users u on u.id = cm.user_id
         where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active
         order by u.full_name`,
        [access.clinicId]
      );
    const services = await c.query(
        `select s.id, s.name, s.name_ar, s.duration_min, s.price, s.color, s.buffer_after_min,
                s.bookable_online, s.active, s.section_id, s.location_kind
         from services s
         left join service_sections sec on sec.id = s.section_id
         where s.clinic_id = $1 and s.active
         order by (s.section_id is null), sec.sort, sec.name, s.sort, s.name`,
        [access.clinicId]
      );
    const sections = await c.query(
        `select id, name, name_ar from service_sections where clinic_id = $1 order by sort, name`,
        [access.clinicId]
      );
    /*
      The clinic's hours, its rooms (each with the services it can host), and
      how many upcoming in-person visits still have no room — the ones booked
      before the clinic added rooms, which block nothing until they are placed.
    */
    const clinic = await c.query(
        `select cl.working_hours, cl.blocked_dates, cl.timezone,
                coalesce((select json_agg(json_build_object(
                           'id', r.id, 'name', r.name, 'name_ar', r.name_ar, 'color', r.color,
                           'serviceIds', coalesce((select json_agg(rs.service_id) from clinic_room_services rs where rs.room_id = r.id), '[]'::json))
                         order by r.sort, r.name)
                   from clinic_rooms r where r.clinic_id = cl.id and r.active), '[]'::json) as rooms,
                (select count(*)::int from appointments a
                   left join services s on s.id = a.service_id
                  where a.clinic_id = cl.id and a.room_id is null and a.starts_at > now()
                    and a.status in ('pending_approval', 'scheduled', 'confirmed')
                    and coalesce(s.location_kind, 'in_person') <> 'online'
                    and exists (select 1 from clinic_rooms r where r.clinic_id = cl.id and r.active)) as unroomed
           from clinics cl where cl.id = $1`,
        [access.clinicId]
      );
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

    /*
      What each patient still owes, for whoever takes money at the desk: a
      treatment is billed whole and paid off over the visits, so the visit is
      when it is asked for. Only for a member who may see invoices, and only
      the invoices they may see — a figure nobody may see is not computed.
    */
    if (can(access, "invoices") && appointments.length) {
      const scope = invoiceScopeSql(access, "i", 3);
      const owed = await c.query(
        `select i.patient_id, sum(i.total - i.amount_paid)::float as due
           from invoices i
          where i.clinic_id = $1 and i.patient_id = any($2::uuid[])
            and i.status in ('draft', 'sent', 'partially_paid') and i.credit_note_of is null${scope.sql}
          group by i.patient_id
         having sum(i.total - i.amount_paid) > 0`,
        [access.clinicId, [...new Set(appointments.map((a) => a.patient_id as string))], ...scope.params]
      );
      const due = new Map(owed.rows.map((r) => [r.patient_id as string, Number(r.due)]));
      appointments = appointments.map((a) => (due.has(a.patient_id) ? { ...a, balance_due: due.get(a.patient_id) } : a));
    }

    return {
      appointments,
      doctors: doctors.rows,
      services: services.rows,
      sections: sections.rows,
      clinicHours: clinic.rows[0].working_hours,
      blockedDates: clinic.rows[0].blocked_dates,
      tz: clinic.rows[0].timezone,
      rooms: clinic.rows[0].rooms,
      unroomed: clinic.rows[0].unroomed,
      currency: access.clinic.currency,
      /* The board's clock: elapsed and waiting times are measured against the
         server, not a laptop that is four minutes fast. */
      serverNow: new Date().toISOString(),
    };
  });
  return NextResponse.json(data);
}
