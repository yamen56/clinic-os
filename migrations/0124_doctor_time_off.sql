------------------------------------------------------------------------------
-- A doctor's days off
--
-- 2026-11-28. A clinic could close whole days (clinics.blocked_dates) and a
-- doctor could set their weekly hours, but nothing said "Dr Laila is away
-- from the 3rd to the 7th". The booking link, the AI receptionist and a
-- patient changing their own visit went on offering her those days, and the
-- desk found out when the patient arrived.
--
-- A day off is a range of whole calendar days in the clinic's timezone,
-- inclusive at both ends, with a short note ("conference", "annual leave").
-- The slot engine (lib/slots) skips the doctor on those days; the calendar
-- greys their column. Visits already booked are never moved — whoever adds
-- the days off is shown the ones that fall on them first.
--
-- Deleted with the membership: it describes a schedule, not a record anybody
-- needs once the doctor has gone.
------------------------------------------------------------------------------

create table if not exists doctor_time_off (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  member_id uuid not null references clinic_members(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  note text not null default '' check (length(note) <= 120),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  -- A year at most in one entry: a longer absence is a membership question.
  check (ends_on - starts_on <= 366)
);
create index if not exists doctor_time_off_member_idx
  on doctor_time_off (clinic_id, member_id, ends_on);

alter table doctor_time_off enable row level security;
drop policy if exists tenant_isolation on doctor_time_off;
create policy tenant_isolation on doctor_time_off for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

grant select, insert, update, delete on doctor_time_off to clinicos_app;
