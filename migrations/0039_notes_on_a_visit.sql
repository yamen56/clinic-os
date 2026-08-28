------------------------------------------------------------------------------
-- Notes that belong to a visit
--
-- `patient_notes.appointment_id` has existed since 0001 and nothing has ever
-- written to it: every note has been about the patient in general, never about
-- the appointment it came out of. Staff wanting "what did we do on the 14th"
-- have had to read the whole file and infer it from timestamps.
--
-- No new column, then — only the index that makes reading a note back from its
-- appointment cheap, and the constraint that stops a note pointing at a visit
-- belonging to somebody else.
------------------------------------------------------------------------------

/*
  Partial, because most notes are not about a specific visit and an index entry
  for every NULL would be most of the table for no lookup.
*/
create index if not exists patient_notes_appointment_idx
  on patient_notes (clinic_id, appointment_id)
  where appointment_id is not null;

/*
  A note follows its appointment out of existence in one direction only.

  0001 attached this FK as `on delete set null`, which is the right answer: a
  cancelled-and-purged appointment must not take the clinical note written at it
  down with it. The note simply stops being about a visit and stays on the file.
  Restated here rather than changed, because it is easy to read the cascade on
  `patient_id` next to it and assume this one matches.
*/
