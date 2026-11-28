------------------------------------------------------------------------------
-- Repeating appointments
--
-- 2026-11-28. Laser hair removal every four weeks, a monthly braces
-- adjustment, ten physiotherapy sessions: the desk booked each one by hand,
-- one panel at a time, and the patient left with one date instead of six.
--
-- A series is the rule the desk chose (every so many days, weeks or months,
-- so many times) and the visits it booked carry its id. Each visit is still
-- an ordinary appointment — moved, finished, billed and reminded on its own;
-- the series only says which ones belong together, so the panel can say
-- "3 of 6" and cancel the rest in one go.
--
-- `planned` is how many were asked for; the visits actually booked are the
-- ones carrying the id (a date the doctor was busy on may have been skipped).
-- A visit outlives its series: deleting the series row only unlinks them.
------------------------------------------------------------------------------

create table if not exists appointment_series (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  every int not null check (every between 1 and 90),
  unit text not null check (unit in ('day', 'week', 'month')),
  planned int not null check (planned between 2 and 30),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists appointment_series_patient_idx on appointment_series (clinic_id, patient_id);

alter table appointments add column if not exists series_id uuid references appointment_series(id) on delete set null;
create index if not exists appointments_series_idx on appointments (series_id, starts_at) where series_id is not null;

alter table appointment_series enable row level security;
drop policy if exists tenant_isolation on appointment_series;
create policy tenant_isolation on appointment_series for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

grant select, insert, update, delete on appointment_series to clinicos_app;
