-- "No further visit needed", said at Finish and kept.
--
-- Yamen, 2026-11-09: finishing a visit should offer to book the next one there
-- and then, or skip it, and the Finished column should say which happened.
-- Booked and not booked are already readable (the patient's next appointment,
-- and next_visit_days from 0088). The third answer was not: "not needed" was
-- stored as no answer at all, the same as a Finish that asked nothing, so the
-- card could not say it.
--
-- A flag of its own rather than next_visit_days = 0: every reader of that
-- column (Due back, the treatment coordinator, the worker's reminders) takes
-- "not null" to mean a visit is wanted.

alter table appointments
  add column if not exists next_visit_none boolean not null default false;

comment on column appointments.next_visit_none is
  'Finish said no further visit is needed (0103). Cleared when the finish is undone.';
