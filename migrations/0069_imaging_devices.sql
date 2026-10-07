-- 0069: the clinic's machines talk to Clinicti without anyone at a browser.
--
-- The x-ray, the OPG, the CBCT and the intraoral camera already reach the
-- patient's file through a person: the chart's camera, or the imaging station
-- tab watching the x-ray software's folder. This is the part that needs no
-- person — a registered device with its own key, sending images over HTTPS
-- (directly, or as DICOM through a relay such as Orthanc), matched to the
-- patient by the number the machine was given, or by the doctor's open
-- "Take x-ray", and otherwise held in an inbox until somebody files it.

------------------------------------------------------------------------------
-- Patient file numbers
--
-- A machine names a patient by an ID somebody typed into it. A UUID cannot be
-- typed, and a phone number changes; every clinic system has a short file
-- number for exactly this, and Clinicti had none. Per clinic, never reused:
-- a counter row rather than max()+1, so deleting the newest patient does not
-- hand their number — and their old x-rays' PatientID — to the next one.
------------------------------------------------------------------------------
create table if not exists patient_numbers (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  last integer not null default 0
);

alter table patients add column if not exists file_no integer;

-- Numbered in the order they were registered. The patients table's own
-- triggers are held for the backfill: it would otherwise stamp every
-- patient's updated_at (which orders the search) and send a realtime event
-- per row to every open workspace.
alter table patients disable trigger patients_touch;
alter table patients disable trigger patients_emit;
with numbered as (
  select id, row_number() over (partition by clinic_id order by created_at, id) as n
    from patients
   where file_no is null
)
update patients p set file_no = numbered.n from numbered where p.id = numbered.id;
alter table patients enable trigger patients_touch;
alter table patients enable trigger patients_emit;

insert into patient_numbers (clinic_id, last)
  select clinic_id, max(file_no) from patients group by clinic_id
  on conflict (clinic_id) do update set last = greatest(patient_numbers.last, excluded.last);

create unique index if not exists patients_file_no_key on patients (clinic_id, file_no);

-- Security definer: the counter is bookkeeping no member reads or writes
-- directly, and every path that creates a patient (staff, booking link,
-- WhatsApp, the AI agent, import) passes through here without knowing.
create or replace function assign_patient_file_no() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.file_no is null then
    insert into patient_numbers as pn (clinic_id, last) values (new.clinic_id, 1)
      on conflict (clinic_id) do update set last = pn.last + 1
      returning last into new.file_no;
  end if;
  return new;
end $$;

drop trigger if exists patients_file_no on patients;
create trigger patients_file_no before insert on patients
  for each row execute function assign_patient_file_no();

------------------------------------------------------------------------------
-- Registered devices
--
-- The key is shown once and stored as its SHA-256: a leaked database row is
-- not a working credential. Revoking is immediate — the key is checked on
-- every call.
------------------------------------------------------------------------------
create table if not exists clinic_devices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null default 'xray' check (kind in ('xray', 'opg', 'cbct', 'camera', 'scanner', 'other')),
  -- What the machine's Patient ID means; see lib/imaging/devices MATCH_BY.
  match_by text not null default 'none' check (match_by in ('none', 'clinicti', 'national_id')),
  key_hash text not null unique,
  key_hint text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_ip text,
  images_received integer not null default 0,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists clinic_devices_clinic_idx on clinic_devices (clinic_id, created_at);

------------------------------------------------------------------------------
-- Where a file came from, and what the machine said about it
--
-- `dicom` is null for an ordinary upload. For a DICOM image it holds the
-- study/series identity, what the machine called the patient, and the
-- original instances; the row's own storage_path is the preview a browser
-- can draw. One row per series, so a CBCT volume of 400 slices is one entry
-- on the Files tab rather than 400.
------------------------------------------------------------------------------
alter table patient_files add column if not exists device_id uuid references clinic_devices(id) on delete set null;
alter table patient_files add column if not exists dicom jsonb;
create unique index if not exists patient_files_dicom_series_key
  on patient_files (clinic_id, (dicom->>'seriesUid')) where dicom is not null;

------------------------------------------------------------------------------
-- Images that arrived for nobody in particular
--
-- A machine that names no patient Clinicti knows, with no doctor waiting on
-- it, still sent somebody's x-ray. It waits here — on the clinic's Imaging
-- page — until it is filed to a patient or discarded.
------------------------------------------------------------------------------
create table if not exists imaging_inbox (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  device_id uuid references clinic_devices(id) on delete set null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  storage_path text not null,
  kind text not null default 'xray' check (kind in ('xray', 'photo')),
  teeth text[] not null default '{}',
  dicom jsonb,
  hint jsonb not null default '{}',
  received_at timestamptz not null default now(),
  assigned_file_id uuid references patient_files(id) on delete set null,
  assigned_at timestamptz,
  assigned_by uuid references users(id) on delete set null,
  discarded_at timestamptz,
  discarded_by uuid references users(id) on delete set null
);
create index if not exists imaging_inbox_open_idx on imaging_inbox (clinic_id, received_at)
  where assigned_at is null and discarded_at is null;
create unique index if not exists imaging_inbox_series_key
  on imaging_inbox (clinic_id, (dicom->>'seriesUid'))
  where dicom is not null and assigned_at is null and discarded_at is null;

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['patient_numbers', 'clinic_devices', 'imaging_inbox'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

drop trigger if exists clinic_devices_touch on clinic_devices;
create trigger clinic_devices_touch before update on clinic_devices
  for each row execute function touch_updated_at();
