-- A patient running late, and what an x-ray is a picture of.
--
-- Yamen, 2026-11-02.
--
-- 1. "When they are late the receptionist adds how many minutes, then a
--    message gets sent to the upcoming patients." A patient who calls to say
--    they will be twenty minutes late pushes the doctor's day back; the people
--    after them can be told, if the desk chooses to. Nothing moves in the
--    calendar: the booking stands, and the message says only that there may
--    be a wait.
--
--      late_min        how late the patient said they would be, or were
--      late_noted_at   when the desk wrote it down, and by whom
--      delay_notice_at when this patient was told the day is running behind,
--                      so the desk does not tell them twice
alter table appointments
  add column if not exists late_min integer check (late_min is null or late_min between 1 and 240),
  add column if not exists late_noted_at timestamptz,
  add column if not exists late_noted_by uuid references users(id) on delete set null,
  add column if not exists delay_notice_at timestamptz;

-- 2. "The x-ray with all of its types: panorama, bitewing, cone beam or the
--    periapical." What a picture shows, read the way a dentist files it. An
--    x-ray is panoramic, bitewing, periapical, occlusal or a CBCT slice; a
--    photo can be an intraoral one. Null is "not said".
alter table patient_files
  add column if not exists view text check (view is null or view in ('panoramic', 'bitewing', 'periapical', 'occlusal', 'cbct', 'intraoral'));

-- 3. "A save button when I finish the changes, so I can send the patient the
--    edited version." An edited picture is a new file beside its original,
--    never a change to it: the original is the record.
alter table patient_files
  add column if not exists edited_from uuid references patient_files(id) on delete set null;
