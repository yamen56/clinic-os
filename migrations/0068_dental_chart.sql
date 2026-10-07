-- The dental chart, saved.
--
-- Until now the chart was a preview that kept everything in the browser. This
-- is where it lives on the patient: every entry recorded on a tooth, an arch or
-- the mouth; every change to an entry, append-only; the clinic's own
-- treatments and its shared favourites; which teeth an x-ray or photo shows;
-- and the requests the imaging station answers when a doctor taps "Take x-ray".
--
-- The treatment catalog itself stays in code (src/lib/charts/dental/catalog.ts)
-- so every entry is guaranteed a drawing and improvements reach every clinic.
-- These tables hold only what a clinic or a doctor adds to it.

------------------------------------------------------------------------------
-- What a clinic practises: one primary specialty (which picks the automation
-- recipes, 0033) plus the other departments of a medical centre. The chart a
-- patient file shows follows from both.
------------------------------------------------------------------------------
alter table clinics add column if not exists specialties text[] not null default '{}';
update clinics set specialties = array[specialty]
 where specialties = '{}' and specialty is not null and specialty <> 'general';

-- The chart is a module the agency switches on per clinic (`features.dental`,
-- opt-in: absent means off). The clinics that already practise dentistry have
-- it from the start; the agency can switch it off on the clinic's page.
update clinics set features = features || '{"dental": true}'::jsonb
 where (specialty = 'dental' or 'dental' = any(specialties))
   and not (features ? 'dental');

------------------------------------------------------------------------------
-- Chart entries
------------------------------------------------------------------------------
create table if not exists chart_marks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  chart text not null default 'dental' check (chart in ('dental')),
  -- An FDI tooth ('16'), a quadrant ('Q1'..'Q4'), an arch, or the whole mouth.
  site text not null check (site ~ '^([1-8][1-8]|Q[1-4]|upper|lower|mouth)$'),
  surfaces text[] not null default '{}',
  treatment_key text not null,
  -- The names as they were when recorded: renaming a treatment never rewrites a record.
  label text not null,
  label_ar text not null,
  abbr text,
  look text not null,
  kind text not null check (kind in ('finding', 'procedure')),
  detail jsonb not null default '{}',
  status text not null check (status in ('existing', 'planned', 'done')),
  -- The teeth of one bridge, splint or partial denture.
  group_id uuid,
  role text check (role in ('abutment', 'pontic')),
  performed_by uuid references clinic_members(id) on delete set null,
  recorded_by uuid references users(id) on delete set null,
  appointment_id uuid references appointments(id) on delete set null,
  note text not null default '',
  done_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references users(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chart_marks_patient_idx on chart_marks (clinic_id, patient_id, created_at);

------------------------------------------------------------------------------
-- What happened to each entry. Never edited, never trimmed while its entry
-- exists; it goes only with the entry (a two-minute undo of a mis-tap, or the
-- patient or clinic being removed) — the 0013 rule for document events.
------------------------------------------------------------------------------
create table if not exists chart_mark_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  mark_id uuid not null references chart_marks(id) on delete cascade,
  action text not null check (action in ('created', 'done', 'void', 'note', 'performer')),
  by_user uuid references users(id) on delete set null,
  reason text,
  at timestamptz not null default now()
);
create index if not exists chart_mark_events_mark_idx on chart_mark_events (mark_id, at);

create or replace function chart_mark_events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'chart_mark_events is append-only (UPDATE is never permitted)'
      using errcode = 'restrict_violation';
  end if;
  -- Cascade: the entry is already gone by the time this fires.
  if not exists (select 1 from chart_marks where id = old.mark_id) then
    return old;
  end if;
  raise exception 'chart_mark_events is append-only (a row cannot be deleted while its entry exists)'
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists chart_mark_events_append_only on chart_mark_events;
create trigger chart_mark_events_append_only
  before update or delete on chart_mark_events
  for each row execute function chart_mark_events_append_only();

------------------------------------------------------------------------------
-- The clinic's own treatments, and the favourites the whole clinic shares
------------------------------------------------------------------------------
create table if not exists chart_treatments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  chart text not null default 'dental' check (chart in ('dental')),
  category text not null,
  name text not null check (length(name) between 1 and 80),
  abbr text check (abbr is null or length(abbr) <= 8),
  scope text not null check (scope in ('surface', 'tooth', 'quadrant', 'arch', 'mouth')),
  look text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Archived, never deleted: past entries point at it by key.
  archived_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists chart_treatments_clinic_idx on chart_treatments (clinic_id, chart);

create table if not exists chart_treatment_favorites (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  chart text not null default 'dental' check (chart in ('dental')),
  treatment_key text not null,
  sort integer not null default 0,
  added_by uuid references users(id) on delete set null,
  added_at timestamptz not null default now(),
  unique (clinic_id, chart, treatment_key)
);

------------------------------------------------------------------------------
-- Which teeth an x-ray or a photo is of
------------------------------------------------------------------------------
alter table patient_files add column if not exists teeth text[] not null default '{}';

------------------------------------------------------------------------------
-- "Take x-ray": a doctor arms the imaging station for a patient (and teeth);
-- the station uploads the next image the x-ray software saves, into that
-- patient's files, and marks the request fulfilled with the file.
------------------------------------------------------------------------------
create table if not exists imaging_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  teeth text[] not null default '{}',
  kind text not null default 'xray' check (kind in ('xray', 'photo')),
  requested_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz,
  file_id uuid references patient_files(id) on delete set null,
  cancelled_at timestamptz
);
create index if not exists imaging_requests_open_idx on imaging_requests (clinic_id, created_at)
  where fulfilled_at is null and cancelled_at is null;

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['chart_marks', 'chart_mark_events', 'chart_treatments', 'chart_treatment_favorites', 'imaging_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

drop trigger if exists chart_marks_touch on chart_marks;
create trigger chart_marks_touch before update on chart_marks
  for each row execute function touch_updated_at();
drop trigger if exists chart_treatments_touch on chart_treatments;
create trigger chart_treatments_touch before update on chart_treatments
  for each row execute function touch_updated_at();
