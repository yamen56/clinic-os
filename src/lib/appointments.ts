import type { PoolClient } from "pg";
import { emitTrigger } from "./triggers";

/**
 * Serialises scheduling for one clinic until the surrounding transaction ends.
 *
 * Every booking path — staff calendar, public link, AI receptionist — checks
 * that a slot is free and then inserts. Those are two statements, and nothing
 * stood between them: two people booking the same slot at the same moment both
 * saw it free (an uncommitted row is invisible under READ COMMITTED) and both
 * wrote. The result is two patients arriving for one appointment, which the
 * clinic only discovers in the waiting room.
 *
 * The lock is taken per clinic rather than per doctor because a booking may
 * still be choosing between doctors when it needs the lock, and because
 * scheduling writes are rare enough that clinic-wide serialisation costs
 * nothing. It is released automatically on commit or rollback.
 *
 * Call this *before* the availability check, never between the check and the
 * insert.
 */
export async function lockClinicSchedule(c: PoolClient, clinicId: string): Promise<void> {
  await c.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [clinicId]);
}

export type AppointmentStatus =
  | "pending_approval"
  | "scheduled"
  | "confirmed"
  | "completed"
  | "no_show"
  | "cancelled";

/**
 * Moves an appointment to a status, with everything that follows from it.
 *
 * The desk's status buttons and an automation confirming an appointment from a
 * patient's "1" go through here, so they cannot drift apart: `finished_at`
 * follows `completed` both ways, a completed visit moves the patient's last
 * visit forward, and the change is announced — which is what sends the consent
 * forms on a confirmation, offers a cancelled slot to the waitlist and tells the
 * doctor.
 *
 * `onlyFrom` refuses the change unless the appointment is in one of those
 * statuses now. An automation passes it, so a patient replying "1" to a
 * reminder cannot un-cancel an appointment the desk has since cancelled.
 */
export async function applyAppointmentStatus(
  c: PoolClient,
  args: {
    clinicId: string;
    appointmentId: string;
    status: AppointmentStatus;
    actorUserId: string | null;
    onlyFrom?: AppointmentStatus[];
    /** Carried on the event so automations reacting to it know how deep they are. */
    chainDepth?: number;
  }
): Promise<
  | { ok: true; patientId: string; previousStatus: string; changed: boolean }
  | { ok: false; error: "not_found" | "bad_state"; previousStatus?: string }
> {
  const cur = (
    await c.query(
      `select status, patient_id, starts_at from appointments where id = $1 and clinic_id = $2 for update`,
      [args.appointmentId, args.clinicId]
    )
  ).rows[0];
  if (!cur) return { ok: false, error: "not_found" };
  if (args.onlyFrom && !args.onlyFrom.includes(cur.status)) {
    return { ok: false, error: "bad_state", previousStatus: cur.status };
  }
  if (args.onlyFrom && cur.status === args.status) {
    return { ok: true, patientId: cur.patient_id, previousStatus: cur.status, changed: false };
  }
  await c.query(
    `update appointments set status = $3::text, flow_prev_status = null,
            finished_at = case when $3::text = 'completed' then coalesce(finished_at, now()) else null end
      where id = $1 and clinic_id = $2`,
    [args.appointmentId, args.clinicId, args.status]
  );
  if (args.status === "completed") {
    await c.query(
      `update patients set last_visit_at = greatest(coalesce(last_visit_at, 'epoch'::timestamptz), $2::timestamptz), status = 'active'
       where id = $1`,
      [cur.patient_id, cur.starts_at]
    );
  }
  await emitTrigger(c, args.clinicId, "appointment_status_changed", {
    appointmentId: args.appointmentId,
    patientId: cur.patient_id,
    status: args.status,
    previousStatus: cur.status,
    actorUserId: args.actorUserId,
    ...(args.chainDepth ? { chainDepth: args.chainDepth } : {}),
  });
  return { ok: true, patientId: cur.patient_id, previousStatus: cur.status, changed: true };
}
