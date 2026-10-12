-- The work done at a visit, found from the visit.
--
-- A treatment done at a visit, and each step of one, carries the appointment
-- it was done at (chart_marks.appointment_id, chart_mark_steps.appointment_id).
-- The calendar and the patient's Appointments tab now show, for each visit,
-- what was done at it — so the lookup goes from the appointment to the work,
-- and needs these.
--
-- The Treatment tab and its cases were taken out of the app the same day
-- (2026-10-12). Their data stays where it is — treatment_cases and
-- chart_marks.case_id are kept, untouched — so the tab can come back.

create index if not exists chart_marks_appointment_idx on chart_marks (appointment_id) where appointment_id is not null;
create index if not exists chart_mark_steps_appointment_idx on chart_mark_steps (appointment_id) where appointment_id is not null;
