import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { emitTrigger } from "@/lib/triggers";
import { pastDayInstant } from "@/lib/dates";
import { visitServiceIds } from "@/lib/appointment-services";
import type { PoolClient } from "pg";

/*
  A visit for now, for a patient who has no appointment today.

  Yamen, 2026-11-15: the visit's prescription and files could not always be
  added — they hang on the visit, and a patient seen without an appointment
  had none. Recording a visit for them now starts one: a walk-in, as the desk
  makes for somebody standing at it (calendar/flow-actions walkInAction),
  already arrived and with the doctor, since the doctor is recording it. So
  the record, the prescription and the files have an appointment, and the
  appointment is in the calendar and the patient's Appointments tab like any
  other.

  A walk-in sends nothing to the patient: no "your appointment is booked",
  no booking alert. It is an arrival, and says so (patient_arrived), as the
  desk's does.

  `recordId`: a record already written for today without a visit — it moves
  onto the new one, rather than leaving the day in two places.
*/

const bodySchema = z.object({
  recordId: z.string().uuid().nullish(),
  /** An earlier day in the clinic's calendar: the visit is that day's (2026-11-20). Today or absent: now. */
  day: z.string().nullish(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const me = access.session.user.id;
  const when = pastDayInstant(parsed.data.day, access.clinic.timezone);
  if (!when.ok) return NextResponse.json({ error: "bad_date" }, { status: 400 });

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" as const };

    // The doctor who is recording, when it is a doctor; otherwise nobody yet — the desk can set it.
    const doctor = access.role === "doctor" && access.memberId ? access.memberId : null;

    /*
      A visit on an earlier day (Yamen, 2026-11-20: "many times I record … and
      it was not today"). That day's visit when the patient had one — written
      up there, not beside it — else one made for that day: already over, at
      midday, by this doctor. It is a record of a day gone, so nothing is
      sent and no automation starts: no arrival, no booking alert.
    */
    if (when.at) {
      const had = (
        await c.query(
          `select a.id from appointments a join clinics cl on cl.id = a.clinic_id
            where a.clinic_id = $1 and a.patient_id = $2 and a.status not in ('cancelled', 'no_show')
              and (a.starts_at at time zone cl.timezone)::date = $3::date
            order by a.starts_at limit 1`,
          [access.clinicId, id, parsed.data.day]
        )
      ).rows[0] as { id: string } | undefined;
      const visit =
        had?.id ??
        ((
          await c.query(
            `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at,
                                       status, source, created_by, arrived_at, seated_at, finished_at, walk_in)
             values ($1, $2, $3, $5::timestamptz, $5::timestamptz + interval '30 minutes',
                     'completed', 'staff', $4, $5::timestamptz, $5::timestamptz, $5::timestamptz + interval '30 minutes', true)
             returning id`,
            [access.clinicId, id, doctor, me, when.at]
          )
        ).rows[0].id as string);
      if (!had) {
        await audit(c, {
          clinicId: access.clinicId,
          userId: me,
          impersonatedBy: access.session.impersonatedBy,
          action: "appointment.past_visit",
          entity: "appointment",
          entityId: visit,
          detail: { patientId: id, day: parsed.data.day, from: "treatment_record" },
        });
      }
      return { visit: await visitRow(c, visit) };
    }

    const r = await c.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at,
                                 status, source, created_by, arrived_at, seated_at, walk_in)
       values ($1, $2, $3, date_trunc('minute', now()), date_trunc('minute', now()) + interval '30 minutes',
               'confirmed', 'staff', $4, now(), now(), true)
       returning id`,
      [access.clinicId, id, doctor, me]
    );
    const visit = r.rows[0].id as string;

    if (parsed.data.recordId) {
      // Only today's record for this patient, and only one not already under a visit.
      await c.query(
        `update visit_records r set appointment_id = $1, doctor_member_id = coalesce(r.doctor_member_id, $5)
           from clinics cl
          where r.id = $2 and r.clinic_id = $3 and r.patient_id = $4 and r.appointment_id is null and cl.id = r.clinic_id
            and (r.created_at at time zone cl.timezone)::date = (now() at time zone cl.timezone)::date`,
        [visit, parsed.data.recordId, access.clinicId, id, doctor]
      );
      // What was done that day with no visit goes with it.
      await c.query(
        `update chart_marks m set appointment_id = $1
           from clinics cl
          where m.clinic_id = $2 and m.patient_id = $3 and m.chart = 'general' and m.appointment_id is null
            and m.status = 'done' and m.voided_at is null and cl.id = m.clinic_id
            and (m.done_at at time zone cl.timezone)::date = (now() at time zone cl.timezone)::date`,
        [visit, access.clinicId, id]
      );
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.walk_in",
      entity: "appointment",
      entityId: visit,
      detail: { patientId: id, from: "treatment_record" },
    });
    await emitTrigger(c, access.clinicId, "patient_arrived", { appointmentId: visit, patientId: id, actorUserId: me, walkIn: true }, `patient_arrived:${visit}`);

    return { visit: await visitRow(c, visit) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ ok: true, ...result });
}

/** The visit as the treatment record reads it. A visit found rather than made may have no arrival, and has its services. */
async function visitRow(c: PoolClient, visit: string) {
  const row = (
    await c.query(
      `select a.id, a.starts_at, a.ends_at, a.status, a.source, a.walk_in, a.created_at, a.arrived_at, a.seated_at, a.doctor_member_id,
              u.full_name as doctor_name, cb.full_name as created_by_name,
              nullif(appointment_service_names(a.id, false), '') as service_name,
              nullif(appointment_service_names(a.id, true), '') as service_name_ar
         from appointments a
         left join clinic_members m on m.id = a.doctor_member_id
         left join users u on u.id = m.user_id
         left join users cb on cb.id = a.created_by
        where a.id = $1`,
      [visit]
    )
  ).rows[0];
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    ...row,
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    created_at: iso(row.created_at),
    arrived_at: iso(row.arrived_at),
    seated_at: iso(row.seated_at),
    service_ids: await visitServiceIds(c, visit),
  };
}
