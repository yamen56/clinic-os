-- A catalogue for the labels a clinic files patients under.
--
-- Tags already existed as `patients.tags text[]`, typed free-hand on each
-- patient. That is fine for putting a label on somebody and useless for running
-- a clinic: nobody can see which tags exist, "سكري" and "سكري " become two
-- different things, and a typo is invisible until a filter quietly returns
-- nothing.
--
-- The array stays exactly as it is — it carries the assignments, it has a GIN
-- index behind the patient filter, and every existing tag keeps working. This
-- table is the vocabulary beside it: what the tags *are*, and what colour each
-- one shows in. Deliberately not a join table; that would mean rewriting the
-- filter, the search and the seed for no gain at this size.

create table if not exists clinic_tags (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 40),
  color text not null default '#6989a6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One spelling per clinic. This is the constraint the whole table exists for.
  unique (clinic_id, name)
);
create index if not exists clinic_tags_clinic_idx on clinic_tags (clinic_id, sort, name);

alter table clinic_tags enable row level security;
drop policy if exists tenant_isolation on clinic_tags;
create policy tenant_isolation on clinic_tags for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

-- Adopt what clinics have already typed, so the catalogue opens full rather
-- than empty and nobody has to re-enter tags that are already in use.
insert into clinic_tags (clinic_id, name)
select distinct p.clinic_id, btrim(t)
  from patients p, unnest(p.tags) as t
 where btrim(t) <> ''
on conflict (clinic_id, name) do nothing;
