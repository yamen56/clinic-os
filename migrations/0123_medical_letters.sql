------------------------------------------------------------------------------
-- Medical letters: sick leave, a medical report, a referral
--
-- 2026-11-28. A doctor in Jordan writes these every day — the sick leave an
-- employer or a school asks for, the report "to whom it may concern", the
-- referral to a specialist or a hospital. Until now they were typed in Word
-- or written on the clinic's paper pad, outside the patient's file.
--
-- They are built like prescriptions (0060): numbered in the clinic's own
-- series, written in a doctor's name and checked to be one, the doctor's
-- name, licence and syndicate numbers copied as they stood, a PDF on the
-- clinic's letterhead with the doctor's saved signature, and sent on WhatsApp
-- or printed. One series for all three kinds, so a number never repeats.
--
-- What each kind needs is held in plain columns rather than a json blob, so
-- the checks below can say what a letter of that kind may not be without:
--   sick_leave  leave_from + leave_days (1–90); the diagnosis is optional —
--               it is the patient's to put in front of an employer.
--   report      addressee (optional, "to whom it may concern"), diagnosis, body.
--   referral    addressee (required: the specialist or hospital), urgent,
--               diagnosis, body (the reason and the findings).
------------------------------------------------------------------------------

create table if not exists medical_letters (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  kind text not null check (kind in ('sick_leave', 'report', 'referral')),
  number integer not null,
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  doctor_member_id uuid references clinic_members(id) on delete set null,
  doctor_name text not null,
  doctor_license_no text,
  doctor_syndicate_no text,
  author_id uuid references users(id) on delete set null,
  -- The visit it was written at, when there was one.
  appointment_id uuid references appointments(id) on delete set null,
  diagnosis text not null default '' check (length(diagnosis) <= 300),
  body text not null default '' check (length(body) <= 4000),
  addressee text not null default '' check (length(addressee) <= 200),
  leave_from date,
  leave_days integer check (leave_days is null or leave_days between 1 and 90),
  urgent boolean not null default false,
  -- Whether the doctor's saved signature was on the PDF when it was made.
  signed boolean not null default false,
  pdf_path text,
  message_id uuid references messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (clinic_id, number),
  check (kind <> 'sick_leave' or (leave_from is not null and leave_days is not null)),
  check (kind <> 'referral' or btrim(addressee) <> '')
);
create index if not exists medical_letters_patient_idx
  on medical_letters (clinic_id, patient_id, created_at desc);

alter table clinics
  add column if not exists letter_counter integer not null default 0;

alter table medical_letters enable row level security;
drop policy if exists tenant_isolation on medical_letters;
create policy tenant_isolation on medical_letters for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

grant select, insert, update, delete on medical_letters to clinicos_app;
