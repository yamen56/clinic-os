-- What a clinic's machine calls a patient, learned once.
--
-- Yamen, 2026-10-31: "make sure that the photos that the device takes are
-- connected to the patient file in both the device and Clinicti — when I take
-- an image from the device it immediately understands that it's for that
-- specific patient."
--
-- A panoramic machine's software keeps its own patients: a folder named
-- "Ababneh Rakan", files named after them, its own patient ID inside each
-- DICOM. Without the Bridge's worklist, Clinicti cannot tell the machine who
-- is in the chair — but it can learn what the machine calls them. The first
-- picture of a patient is filed by a person, once; from then on every picture
-- the machine saves under that name goes to that patient by itself.
--
-- `key` is how the machine named them, normalised (lib/imaging/ingest.ts,
-- sourceKeys):
--   id:<the machine's patient ID>       from a DICOM
--   folder:<the folder's words>         the folder the software files them in
--   file:<the file name's words>        the file name without its numbers
-- `label` is the same, as the machine wrote it, for the patient's Files to show.
--
-- A link is only learned from a name that holds the patient's own name, and
-- only used while no other patient's name holds it too — so a date folder or
-- "Images" never becomes somebody's, and a namesake registered later turns it
-- back into a question. Forgetting one is a delete.
create table if not exists imaging_patient_links (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  key text not null,
  label text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (clinic_id, key)
);
create index if not exists imaging_patient_links_patient_idx on imaging_patient_links (patient_id);

alter table imaging_patient_links enable row level security;
drop policy if exists tenant_isolation on imaging_patient_links;
create policy tenant_isolation on imaging_patient_links for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());
