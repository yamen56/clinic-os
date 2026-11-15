/**
 * Which visit a treatment was done at, and when — for the routes that record
 * one as done.
 *
 * Named by the screen (the record sheet is open on a visit): that visit, done
 * now when it is today's and at the visit's own time when it is being written
 * up afterwards. Not named: today's visit when the patient has one, else no
 * visit at all — the treatment then stands by its date. Nothing is done at a
 * visit that has not happened, or at one that was cancelled.
 */

import type { PoolClient } from "pg";
import { todaysVisit } from "@/lib/charts/dental/server";

export async function visitFor(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  appointmentId: string | null | undefined,
  performerId: string | null
): Promise<{ visit: string | null; doneAt: Date | null } | { error: "invalid_visit" }> {
  if (!appointmentId) return { visit: await todaysVisit(c, clinicId, patientId, null, performerId), doneAt: null };
  // A foreign key does not see row security: the visit is checked against this patient by hand.
  const a = (
    await c.query(
      `select a.starts_at,
              (a.starts_at at time zone cl.timezone)::date = (now() at time zone cl.timezone)::date as today
         from appointments a join clinics cl on cl.id = a.clinic_id
        where a.id = $1 and a.patient_id = $2 and a.clinic_id = $3 and a.status not in ('cancelled', 'no_show')`,
      [appointmentId, patientId, clinicId]
    )
  ).rows[0];
  if (!a || (!a.today && new Date(a.starts_at).getTime() > Date.now())) return { error: "invalid_visit" };
  return { visit: appointmentId, doneAt: a.today ? null : new Date(a.starts_at) };
}
