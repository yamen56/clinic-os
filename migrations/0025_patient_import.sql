-- Importing a clinic's existing records.
--
-- The blocker on switching systems is never the software, it is the five years
-- of patients already written down somewhere else. `patients.source` has had an
-- 'import' value since 0001 and nothing has ever produced it.
--
-- Everything here exists to make an import reversible. An operator maps columns
-- from a file nobody has seen before, and the first attempt is often wrong —
-- the phone column was actually the file number, the dates were month-first.
-- Without a way back, being wrong means a clinic's patient list is now a mess
-- that has to be unpicked by hand.

create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  filename text not null default '',
  -- What the operator chose, kept so a repeat import of the same export does
  -- not start from guesses again.
  mapping jsonb not null default '[]',
  row_count integer not null default 0,
  created_count integer not null default 0,
  matched_count integer not null default 0,
  skipped_count integer not null default 0,
  undone_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists import_batches_clinic_idx on import_batches (clinic_id, created_at desc);

/*
  Which import a patient arrived on, and null for everyone else.

  This is what makes undo safe: it identifies exactly the rows one import
  created, so an undo can remove those and nothing else. Patients the import
  *matched* to existing files are deliberately not stamped — they existed
  before, and undoing an import must not delete them.
*/
alter table patients
  add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
create index if not exists patients_import_batch_idx on patients (import_batch_id)
  where import_batch_id is not null;

do $$
begin
  execute 'alter table import_batches enable row level security';
  execute 'drop policy if exists tenant_isolation on import_batches';
  execute
    'create policy tenant_isolation on import_batches for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())';
  execute 'drop trigger if exists import_batches_touch on import_batches';
  execute 'create trigger import_batches_touch before update on import_batches for each row execute function touch_updated_at()';
end $$;
