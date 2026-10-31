import type { PoolClient } from "pg";

/**
 * Due back: every patient whose last visit asked for another (migration 0088)
 * that nobody has booked.
 *
 * Read from the visit with the hand-off, newest per patient, and dropped as
 * soon as any later visit is booked for them — a visit they came to, or one
 * still to come. A no-show or a cancellation does not count: they are due
 * again. Due now, overdue, or within the coming week, the most overdue first,
 * so reception calls the ones who have waited longest.
 *
 * This is the recall list the clinic never had to build by hand: the doctor
 * said "two weeks" on the finish sheet and that is the whole of the setup.
 */
export type DueBack = {
  appointmentId: string;
  patientId: string;
  patientName: string;
  phone: string | null;
  dueAt: string;
  /** Negative while still ahead of the due date. */
  daysLate: number;
  startsAt: string;
  finishedAt: string | null;
  nextVisitDays: number;
  nextVisitMin: number | null;
  doctorId: string | null;
  doctorName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  serviceNameAr: string | null;
  deskNote: string;
};

const DUE_SQL = `
  with latest as (
    select distinct on (a.patient_id)
           a.id, a.patient_id, a.starts_at, a.finished_at, a.next_visit_days, a.next_visit_min,
           coalesce(a.next_visit_member_id, a.doctor_member_id) as doctor_id, a.service_id, a.desk_note,
           coalesce(a.finished_at, a.starts_at) + make_interval(days => a.next_visit_days) as due_at
      from appointments a
     where a.clinic_id = $1 and a.status = 'completed' and a.next_visit_days is not null
     order by a.patient_id, coalesce(a.finished_at, a.starts_at) desc
  )
  select l.*, p.full_name, p.phone_e164, u.full_name as doctor_name, s.name as service_name, s.name_ar as service_name_ar
    from latest l
    join patients p on p.id = l.patient_id and p.merged_into is null and p.status <> 'archived'
    left join clinic_members m on m.id = l.doctor_id
    left join users u on u.id = m.user_id
    left join services s on s.id = l.service_id
   where l.due_at < now() + make_interval(days => $2)
     and not exists (
       select 1 from appointments b
        where b.clinic_id = $1 and b.patient_id = l.patient_id and b.starts_at > l.starts_at
          and b.status not in ('cancelled', 'no_show'))`;

export async function dueBackList(c: PoolClient, clinicId: string, aheadDays = 7, limit = 100): Promise<DueBack[]> {
  const r = await c.query(`${DUE_SQL} order by l.due_at limit $3`, [clinicId, aheadDays, limit]);
  const now = Date.now();
  return r.rows.map((x) => ({
    appointmentId: x.id,
    patientId: x.patient_id,
    patientName: x.full_name,
    phone: x.phone_e164 ?? null,
    dueAt: new Date(x.due_at).toISOString(),
    daysLate: Math.floor((now - new Date(x.due_at).getTime()) / 86_400_000),
    startsAt: new Date(x.starts_at).toISOString(),
    finishedAt: x.finished_at ? new Date(x.finished_at).toISOString() : null,
    nextVisitDays: Number(x.next_visit_days),
    nextVisitMin: x.next_visit_min ?? null,
    doctorId: x.doctor_id ?? null,
    doctorName: x.doctor_name ?? null,
    serviceId: x.service_id ?? null,
    serviceName: x.service_name ?? null,
    serviceNameAr: x.service_name_ar ?? null,
    deskNote: x.desk_note ?? "",
  }));
}

/** How many are due now or overdue — the dashboard's count. */
export async function dueBackCount(c: PoolClient, clinicId: string): Promise<number> {
  const r = await c.query(`select count(*)::int as n from (${DUE_SQL}) d`, [clinicId, 0]);
  return r.rows[0].n as number;
}
