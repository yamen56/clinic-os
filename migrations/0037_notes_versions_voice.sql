------------------------------------------------------------------------------
-- Patient notes: categories a clinic defines, a history that survives editing,
-- and voice.
--
-- Three changes that belong together because they are all about the same thing:
-- a note is a clinical record, and a clinical record is not a scratchpad.
--
--  * `kind` was two hard-coded values, 'clinical' and 'admin', chosen by us for
--    every clinic in every specialty. It becomes a clinic-defined list.
--  * Notes could be deleted outright. They no longer can — a note is corrected,
--    and the correction never destroys what it replaced.
--  * A doctor between patients can say something in fifteen seconds that would
--    take two minutes to type, so a note can now be a recording.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- Categories
------------------------------------------------------------------------------
create table if not exists note_categories (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  /*
    A stable key for the two that ship with every clinic. The platform never
    reads it, but it is what lets the backfill below find them again, and what
    keeps "Clinical" from being renamed into something a migration cannot match.
  */
  key text,
  name text not null,
  name_ar text,
  color text not null default '#6989a6',
  -- System categories can be renamed, recoloured and reordered, never deleted:
  -- every note that existed before this migration points at one of them.
  is_system boolean not null default false,
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, key)
);
create index if not exists note_categories_clinic_idx on note_categories (clinic_id, sort);

-- The two that were hard-coded, now rows, for every clinic that exists.
insert into note_categories (clinic_id, key, name, name_ar, color, is_system, sort)
select cl.id, 'clinical', 'Clinical', 'سريري', '#0f6e5c', true, 10 from clinics cl
on conflict (clinic_id, key) do nothing;
insert into note_categories (clinic_id, key, name, name_ar, color, is_system, sort)
select cl.id, 'admin', 'Administrative', 'إداري', '#6989a6', true, 20 from clinics cl
on conflict (clinic_id, key) do nothing;

------------------------------------------------------------------------------
-- The note itself
------------------------------------------------------------------------------
alter table patient_notes
  add column if not exists category_id uuid references note_categories(id) on delete set null,
  -- Set the first time a note is changed after it was written, so the UI can
  -- say "edited" without comparing timestamps that `updated_at` also moves.
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references users(id) on delete set null,
  -- A voice note. The body stays usable alongside it — staff type a line of
  -- context, or nothing at all.
  add column if not exists audio_path text,
  add column if not exists audio_mime text,
  add column if not exists audio_seconds integer;

-- Every existing note keeps the category it already had.
update patient_notes n
   set category_id = c.id
  from note_categories c
 where c.clinic_id = n.clinic_id and c.key = n.kind and n.category_id is null;

create index if not exists patient_notes_category_idx on patient_notes (clinic_id, category_id);

/*
  `kind` is left in place rather than dropped.

  Dropping it is the tidy move and the wrong one today: this migration runs on a
  live database, the web and worker containers roll one after the other, and for
  the length of that rollout the old code is still inserting `kind`. A column
  with a default costs nothing to keep and can go in a later migration, once
  nothing has written to it for a release. Until then `category_id` is the truth
  and every reader has moved to it.
*/

------------------------------------------------------------------------------
-- History
------------------------------------------------------------------------------
/*
  What the note said, each time somebody stopped typing.

  This is the half of "no delete button" that matters. Removing the button only
  stops the crude form of losing a record; editing a note down to nothing loses
  exactly as much, and quietly. Every version is kept, the first one is the
  original, and the note itself is only ever the latest.
*/
create table if not exists patient_note_versions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  note_id uuid not null references patient_notes(id) on delete cascade,
  body text not null default '',
  category_id uuid references note_categories(id) on delete set null,
  /* Who wrote *this* version, which is not always who wrote the note. */
  author_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists patient_note_versions_note_idx
  on patient_note_versions (note_id, created_at);

-- Every note that already exists gets its current text as version one, so the
-- history is never empty and "the original" always resolves to something.
insert into patient_note_versions (clinic_id, note_id, body, category_id, author_id, created_at)
select n.clinic_id, n.id, n.body, n.category_id, n.author_id, n.created_at
  from patient_notes n
 where not exists (select 1 from patient_note_versions v where v.note_id = n.id);

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['note_categories', 'patient_note_versions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

drop trigger if exists note_categories_touch on note_categories;
create trigger note_categories_touch before update on note_categories
  for each row execute function touch_updated_at();

/*
  New clinics get the same two categories. `seed_esign_defaults` is the existing
  hook for "everything a clinic must have on day one", so this rides along with
  it rather than becoming a second thing the clinic-creation path must remember.
*/
create or replace function seed_note_categories(p_clinic uuid) returns void language plpgsql as $$
begin
  insert into note_categories (clinic_id, key, name, name_ar, color, is_system, sort)
  values
    (p_clinic, 'clinical', 'Clinical', 'سريري', '#0f6e5c', true, 10),
    (p_clinic, 'admin', 'Administrative', 'إداري', '#6989a6', true, 20)
  on conflict (clinic_id, key) do nothing;
end $$;
