/**
 * Whether anything in the file hangs on an appointment.
 *
 * Yamen, 2026-11-20: cancelled visits sat in a patient's Appointments tab with
 * no way to clear them. A cancelled booking that nothing was written under —
 * no invoice, note, treatment, prescription, file, record or document — is
 * only noise, and may be deleted. One that has something under it stays: the
 * foreign keys would quietly unhook that thing from its day.
 *
 * Every table with a foreign key to `appointments` is here except the ones
 * that are the booking itself (its services and items), its automation runs
 * (reminders for a visit that will not happen) and on-call fees (only a
 * completed visit has one). A new table that hangs on a visit belongs here.
 *
 * `alias` is interpolated, so it is only ever a literal written in code.
 */
export function appointmentAttachedSql(alias: string): string {
  const id = `${alias}.id`;
  return `(
    exists (select 1 from invoices x where x.appointment_id = ${id})
    or exists (select 1 from patient_notes x where x.appointment_id = ${id})
    or exists (select 1 from chart_marks x where x.appointment_id = ${id})
    or exists (select 1 from chart_mark_steps x where x.appointment_id = ${id})
    or exists (select 1 from visit_records x where x.appointment_id = ${id})
    or exists (select 1 from prescriptions x where x.appointment_id = ${id})
    or exists (select 1 from patient_files x where x.appointment_id = ${id})
    or exists (select 1 from documents x where x.appointment_id = ${id})
    or exists (select 1 from waitlist_entries x where x.booked_appointment_id = ${id})
  )`;
}
