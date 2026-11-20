/**
 * The day a piece of chart work was done, set by hand.
 *
 * Yamen, 2026-11-20: "when I record … a procedure that was done in the charts
 * I want the ability to change the date, because many times it was not
 * today". Work is recorded now, at today's visit; this moves a done entry to
 * the day it really happened — the tooth chart, the face chart and the
 * treatment record alike, since they are the same row.
 *
 * The entry goes under that day's visit when the patient had one (the one it
 * is already under, if that is on the day), and is done at the visit's own
 * time, which is what recording work at a past visit does (visitFor). With no
 * visit that day it stands by its date: midday, in the clinic's timezone.
 * Moved back to today it is done now, at today's visit if there is one.
 *
 * Only done, standing entries move — a plan has no day it was done on, and a
 * voided one takes no change. The aftercare automation is not re-run: it
 * fires on becoming done, and ignores work that is not recent anyway.
 */

import type { PoolClient } from "pg";
import { pastDayInstant } from "@/lib/dates";

export async function redateMarks(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  markIds: string[],
  day: string,
  tz: string
): Promise<{ ok: true; changed: string[] } | { ok: false; error: "bad_date" }> {
  const when = pastDayInstant(day, tz);
  if (!when.ok) return { ok: false, error: "bad_date" };
  if (!markIds.length) return { ok: true, changed: [] };

  const lead = (await c.query(`select appointment_id from chart_marks where id = $1 and clinic_id = $2`, [markIds[0], clinicId])).rows[0];
  const visit = (
    await c.query(
      `select a.id, a.starts_at
         from appointments a join clinics cl on cl.id = a.clinic_id
        where a.clinic_id = $1 and a.patient_id = $2 and a.status not in ('cancelled', 'no_show')
          and (a.starts_at at time zone cl.timezone)::date = $3::date
        order by (a.id = $4::uuid) desc nulls last,
                 (a.seated_at is not null) desc,
                 a.starts_at
        limit 1`,
      [clinicId, patientId, day, lead?.appointment_id ?? null]
    )
  ).rows[0] as { id: string; starts_at: Date } | undefined;

  // Today: now. Another day: that day's visit, or midday when there was none.
  const at = when.at === null ? new Date() : visit ? new Date(visit.starts_at) : new Date(when.at);
  const r = await c.query(
    `update chart_marks set done_at = $3, appointment_id = $4
      where id = any($1::uuid[]) and clinic_id = $2 and status = 'done' and voided_at is null
      returning id`,
    [markIds, clinicId, at.toISOString(), visit?.id ?? null]
  );
  return { ok: true, changed: r.rows.map((x) => x.id as string) };
}
