-- The treatment record, for every clinic.
--
-- Yamen, 2026-11-15: "a treatment section so the thing that the doctor does
-- can be recorded for this specific patient … connected to the charts".
--
-- A dental clinic records its work on the tooth chart and a face clinic on the
-- face chart. Every other clinic had the name of the booked service and a free
-- note, and nothing else. This gives every clinic the same record:
--
--   1. what the visit was — the complaint, the examination, the diagnosis and
--      the plan — one row per visit (`visit_records`);
--   2. what was done at it — a treatment from the clinic's price list that has
--      no drawing to go on (a consultation, a dressing, a session) — as a
--      chart entry of chart 'general'.
--
-- The second is the whole point of the design. Work with no drawing is the
-- same kind of thing as a filling or a filler: who did it, at which visit, for
-- what price, billed or not, voided never deleted. So it is the same row, and
-- it gets the history, the two-minute undo, Ready to bill and the doctor's
-- share that chart work already has. The tooth chart and the face chart stay
-- the only place their own work is entered; the record reads it.

------------------------------------------------------------------------------
-- 1. The visit's clinical record
------------------------------------------------------------------------------
create table if not exists visit_records (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  -- The visit it is about. Null for a record written on a day the patient had
  -- no appointment: it stands by its date.
  appointment_id uuid references appointments(id) on delete set null,
  doctor_member_id uuid references clinic_members(id) on delete set null,
  complaint text not null default '' check (length(complaint) <= 4000),
  exam text not null default '' check (length(exam) <= 8000),
  diagnosis text not null default '' check (length(diagnosis) <= 2000),
  plan text not null default '' check (length(plan) <= 4000),
  recorded_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One record per visit: the second doctor to open it edits the first one's.
create unique index if not exists visit_records_appointment_key on visit_records (appointment_id) where appointment_id is not null;
create index if not exists visit_records_patient_idx on visit_records (clinic_id, patient_id, created_at desc);

comment on table visit_records is
  'What a visit was: complaint, examination, diagnosis and plan, one row per visit (0108). What was done is chart_marks.';

-- What the record said before it was changed. The record is saved as it is
-- typed, so a version is one sitting — the same person within ten minutes
-- rewrites their own latest version rather than adding a row per keystroke.
create table if not exists visit_record_versions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  record_id uuid not null references visit_records(id) on delete cascade,
  complaint text not null default '',
  exam text not null default '',
  diagnosis text not null default '',
  plan text not null default '',
  author_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists visit_record_versions_record_idx on visit_record_versions (record_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['visit_records', 'visit_record_versions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- An open file re-reads the record when a colleague changes it (0072).
drop trigger if exists visit_records_emit on visit_records;
create trigger visit_records_emit after insert or update or delete on visit_records
  for each row execute function emit_patient_change();

------------------------------------------------------------------------------
-- 2. Treatments with no drawing
--
-- chart 'general', site 'body'. `service_id` is the line of the price list it
-- is, `label`/`label_ar` its names as they were that day, `fee` its price that
-- day (null: typed by hand, not on the list). Every reader of the tooth chart
-- and the face chart already asks for its own chart by name, so these are on
-- neither.
------------------------------------------------------------------------------
alter table chart_marks drop constraint if exists chart_marks_chart_check;
alter table chart_marks add constraint chart_marks_chart_check check (chart in ('dental', 'aesthetic', 'general'));

alter table chart_marks drop constraint if exists chart_marks_site_check;
alter table chart_marks add constraint chart_marks_site_check check (
  (chart = 'dental' and site ~ '^([1-8][1-8]|Q[1-4]|upper|lower|mouth)$')
  or (chart = 'aesthetic' and site in ('face', 'body'))
  or (chart = 'general' and site = 'body')
);

-- The sessions of one course ("physiotherapy × 6") share this. Not group_id:
-- billing reads a group as a bridge and bills it once on its lead.
alter table chart_marks add column if not exists course_id uuid;
create index if not exists chart_marks_course_idx on chart_marks (course_id) where course_id is not null;
comment on column chart_marks.course_id is
  'General treatments: the course a session belongs to (0108). Each session is its own entry, billed when done.';

create index if not exists chart_marks_general_idx on chart_marks (clinic_id, service_id, recorded_by) where chart = 'general';
