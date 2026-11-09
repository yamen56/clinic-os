-- The treatment coordinator (a test, behind the opt-in `coordinator` feature):
-- the system books a patient's next session itself where the next visit is
-- clear, and invites where it is not. See src/lib/courses.ts.

-- A service given as a course: so many sessions, so far apart. Blank on both
-- is a single visit, which is every service until a clinic says otherwise.
alter table services
  add column if not exists course_sessions integer check (course_sessions is null or course_sessions between 2 and 100),
  add column if not exists course_interval_days integer check (course_interval_days is null or course_interval_days between 1 and 365);

-- How far apart a face package's sessions are. Null reads as four weeks.
alter table package_plans
  add column if not exists interval_days integer check (interval_days is null or interval_days between 1 and 365);

-- Reception's "Stop following": the treatments a patient had in progress when
-- it was pressed are left alone from then on. One that starts afterwards — a
-- new package, a new plan — is followed again, so a stop is never for ever.
create table if not exists treatment_follow_stops (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  stopped_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists treatment_follow_stops_patient_idx on treatment_follow_stops (clinic_id, patient_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['treatment_follow_stops'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

grant select, insert, update, delete on treatment_follow_stops to clinicos_app;
