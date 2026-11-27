/**
 * Whether a member of staff has left anything in the clinic's records.
 *
 * Yamen, 2026-11-20: the staff list showed "multiple people that I entered by
 * fault", greyed out and impossible to get rid of. Somebody added by mistake
 * has done nothing — no visit is theirs, no invoice line, no treatment — and
 * can be deleted outright. Somebody who worked here is named on those rows,
 * and deleting the membership would wipe the name off them (or, for the
 * payouts and invoice lines, delete the rows themselves), so they stay:
 * removed, out of the way, and still who did the work.
 *
 * Every table with a foreign key to `clinic_members` is here, apart from
 * `service_doctors`, which is the price list's own setting and goes with them.
 * A new table that names a member belongs in this list.
 *
 * `alias` is interpolated, so it is only ever a literal written in code.
 */
export function memberHistorySql(alias: string): string {
  const id = `${alias}.id`;
  return `(
    exists (select 1 from appointments x where x.doctor_member_id = ${id})
    or exists (select 1 from appointments x where x.next_visit_member_id = ${id})
    or exists (select 1 from chart_marks x where x.performed_by = ${id})
    or exists (select 1 from chart_mark_steps x where x.performed_by = ${id})
    or exists (select 1 from invoice_line_doctors x where x.doctor_member_id = ${id})
    or exists (select 1 from doctor_payouts x where x.doctor_member_id = ${id})
    or exists (select 1 from on_call_visits x where x.doctor_member_id = ${id})
    or exists (select 1 from prescriptions x where x.doctor_member_id = ${id})
    or exists (select 1 from medical_letters x where x.doctor_member_id = ${id})
    or exists (select 1 from treatment_cases x where x.doctor_member_id = ${id})
    or exists (select 1 from visit_records x where x.doctor_member_id = ${id})
    or exists (select 1 from waitlist_entries x where x.doctor_member_id = ${id})
    or exists (select 1 from booking_links x where x.doctor_member_id = ${id})
  )`;
}
