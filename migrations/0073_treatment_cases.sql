-- Treatment: cases, the steps of a treatment, visits, and medical history.
--
-- A dentist asked for the chart to run the treatment, not only record it:
-- each new problem its own case — what brought the patient in, the history,
-- the examination, the diagnosis and the plan — and each treatment's steps as
-- they are done at each visit (the access, the working length of every canal,
-- the obturation), how many sessions it took, an emergency in the middle of
-- it without losing the plan, and the next visit booked with what is planned
-- for it.

------------------------------------------------------------------------------
-- Cases
--
-- A patient may have more than one open at once: orthodontics running for a
-- year beside a new pain this week. Closed, a case stays as it was: the record
-- of that problem and what was done about it.
------------------------------------------------------------------------------
create table if not exists treatment_cases (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  title text not null default '' check (length(title) <= 120),
  complaint text not null default '' check (length(complaint) <= 2000),
  history text not null default '' check (length(history) <= 8000),
  exam text not null default '' check (length(exam) <= 8000),
  diagnosis text not null default '' check (length(diagnosis) <= 4000),
  doctor_member_id uuid references clinic_members(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'closed')),
  -- The patient's medical history was looked at again for this case.
  medical_reviewed_at timestamptz,
  medical_reviewed_by uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references users(id) on delete set null
);
create index if not exists treatment_cases_patient_idx on treatment_cases (clinic_id, patient_id, created_at desc);

------------------------------------------------------------------------------
-- What a chart entry belongs to, and an emergency's mark
------------------------------------------------------------------------------
alter table chart_marks
  add column if not exists case_id uuid references treatment_cases(id) on delete set null,
  add column if not exists emergency boolean not null default false;
create index if not exists chart_marks_case_idx on chart_marks (case_id) where case_id is not null;

------------------------------------------------------------------------------
-- The steps of a treatment, as they are done
--
-- Who did it, who recorded it, at which visit, with what (the canal lengths,
-- the irrigants, the implants' sizes). Voided, never edited away: a step
-- recorded by mistake leaves the record the way an entry does. The two-minute
-- undo of a mis-tap deletes, as it does for entries.
------------------------------------------------------------------------------
create table if not exists chart_mark_steps (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  mark_id uuid not null references chart_marks(id) on delete cascade,
  -- Carried so a change announces whose chart it is on (emit_patient_change).
  patient_id uuid not null references patients(id) on delete cascade,
  step text not null check (length(step) between 1 and 40),
  data jsonb not null default '{}',
  note text not null default '' check (length(note) <= 2000),
  performed_by uuid references clinic_members(id) on delete set null,
  recorded_by uuid references users(id) on delete set null,
  appointment_id uuid references appointments(id) on delete set null,
  done_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references users(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chart_mark_steps_mark_idx on chart_mark_steps (mark_id, done_at);
create index if not exists chart_mark_steps_patient_idx on chart_mark_steps (clinic_id, patient_id);

------------------------------------------------------------------------------
-- The plan's items booked into a visit
------------------------------------------------------------------------------
create table if not exists appointment_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  mark_id uuid not null references chart_marks(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, mark_id)
);
create index if not exists appointment_items_mark_idx on appointment_items (mark_id);

------------------------------------------------------------------------------
-- Medical history: once per patient, looked at again in each case
------------------------------------------------------------------------------
alter table patients add column if not exists medical_history jsonb not null default '{}';

------------------------------------------------------------------------------
-- What an entry's history can say happened to it
------------------------------------------------------------------------------
alter table chart_mark_events drop constraint if exists chart_mark_events_action_check;
alter table chart_mark_events add constraint chart_mark_events_action_check
  check (action in ('created', 'done', 'void', 'note', 'performer', 'step', 'step_void', 'case', 'reopened'));

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['treatment_cases', 'chart_mark_steps', 'appointment_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
    execute format('drop trigger if exists %I on %I', t || '_emit', t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function emit_patient_change()', t || '_emit', t);
  end loop;
end $$;
