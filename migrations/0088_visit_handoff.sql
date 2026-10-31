-- The end of a visit, handed from the doctor to the desk.
--
-- Yamen, 2026-10-31: the doctor's day comes first, and the complaint is that
-- "things don't talk to each other". Finish only flipped the visit to
-- completed: reception guessed what to bill, and Book next opened an hour from
-- now with nothing to say when the patient should come back.
--
-- Finishing now says, optionally, three things — when the next visit should be,
-- how long and with whom, and a line for reception. They live on the visit
-- they came out of, because that is what they are about: the board's finished
-- card reads them to book the next visit on the right day, and the Due back
-- list is every patient whose last visit asked for another that nobody has
-- booked yet.
--
--   next_visit_days       in how many days from the visit; null is "none asked"
--   next_visit_min        how long it should be; null takes the service's length
--   next_visit_member_id  with whom; null is whoever is free
--   desk_note             the doctor's line to reception, never to the patient
--   handed_off_at/_by     when and by whom it was said, which is what tells a
--                         visit finished with a hand-off from one finished with
--                         Skip
alter table appointments
  add column if not exists next_visit_days integer check (next_visit_days is null or next_visit_days between 1 and 730),
  add column if not exists next_visit_min integer check (next_visit_min is null or next_visit_min between 5 and 480),
  add column if not exists next_visit_member_id uuid references clinic_members(id) on delete set null,
  add column if not exists desk_note text not null default '' check (length(desk_note) <= 500),
  add column if not exists handed_off_at timestamptz,
  add column if not exists handed_off_by uuid references users(id) on delete set null;

-- Due back: the visits that asked for another, newest first per patient.
create index if not exists appointments_due_back_idx
  on appointments (clinic_id, patient_id, finished_at desc)
  where next_visit_days is not null;

-- A prescription written in the room belongs to that visit, as its notes and
-- its chart work already do. Deleting the visit unfiles it, never removes it.
alter table prescriptions
  add column if not exists appointment_id uuid references appointments(id) on delete set null;
