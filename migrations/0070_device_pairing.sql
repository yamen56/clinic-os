-- 0070: a doctor connects a machine, without an IT person.
--
-- 0069 gave each device a key to paste into a relay's configuration — fine
-- for an engineer, not for a dentist. Now the Clinicti Bridge (a program the
-- doctor downloads and runs on the imaging computer) is paired with a short
-- code shown in Settings → Devices, and is handed its key itself; nobody ever
-- sees or copies it. The Bridge reports back what it is doing — which folder,
-- which DICOM address, whether the machine has answered — so the setup screen
-- can tick each step as it starts working.

-- 'bridge': paired with a code, runs the Clinicti Bridge.
-- 'api':    a key handed to other software (a PACS, a script).
alter table clinic_devices add column if not exists method text not null default 'api';
alter table clinic_devices drop constraint if exists clinic_devices_method_check;
alter table clinic_devices add constraint clinic_devices_method_check check (method in ('bridge', 'api'));

-- The pairing code, hashed like the key, and good for fifteen minutes.
alter table clinic_devices add column if not exists pair_code_hash text;
alter table clinic_devices add column if not exists pair_expires_at timestamptz;
alter table clinic_devices add column if not exists paired_at timestamptz;
create unique index if not exists clinic_devices_pair_code_key on clinic_devices (pair_code_hash)
  where pair_code_hash is not null;

-- What the Bridge last said about itself: computer name, version, the folder
-- it watches, the address machines send to, the last time a machine answered.
alter table clinic_devices add column if not exists bridge jsonb;

-- More kinds of machine, and any kind of file one makes: an intraoral
-- scanner's STL, an ultrasound's PDF report.
alter table clinic_devices drop constraint if exists clinic_devices_kind_check;
alter table clinic_devices add constraint clinic_devices_kind_check
  check (kind in ('xray', 'opg', 'cbct', 'camera', 'scanner', 'ultrasound', 'other'));
alter table imaging_inbox drop constraint if exists imaging_inbox_kind_check;
alter table imaging_inbox add constraint imaging_inbox_kind_check check (kind in ('xray', 'photo', 'other'));
