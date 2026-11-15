-- A file knows the visit it was added at.
--
-- Yamen, 2026-11-15, on the treatment record: "put the ability to give
-- prescription and files, and of course they should be connected".
--
-- A prescription has carried its visit since 0088. A file did not: a photo of
-- a wound taken in the room was only "a photo, today". From here a file added
-- from a visit's record is filed under that visit, and the record shows it
-- there. Null for every file before this and for one added from the Files tab
-- — those stand by their date, as they always did. Deleting the visit unfiles
-- it, never removes it.
alter table patient_files
  add column if not exists appointment_id uuid references appointments(id) on delete set null;
create index if not exists patient_files_appointment_idx on patient_files (appointment_id) where appointment_id is not null;

comment on column patient_files.appointment_id is
  'The visit this file was added at, from the visit''s record (0109). Null: it stands by its date.';
