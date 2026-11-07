-- The clinic's own face treatments, and the kinds of each.
--
-- Yamen, 2026-11-07: the doctor should "be able to add more treatments other than
-- the added ones, with its possible variants". The thirteen treatments in
-- src/lib/charts/face/catalog.ts stay as they are; these are the clinic's own,
-- beside them, keyed `aes_c_<id>` so they sort with the face chart's prices
-- (prices are split by the `aes_` prefix) and never with the dental list.
--
-- Not `chart_treatments`: its required columns (scope, category, look) mean
-- things only to the dental chart.
--
-- A variant is a kind of the work, for any treatment, built-in or the clinic's:
-- a TCA or a glycolic peel, PDO or PLLA threads. It may have a price of its own
-- (a service whose chart_variant is the variant's id) and may preselect a
-- product. Neither table is ever deleted from: past chart entries name them.

create table if not exists aesthetic_treatments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  key text not null,
  name text not null check (length(name) between 1 and 80),
  name_ar text check (name_ar is null or length(name_ar) between 1 and 80),
  family text not null check (family in ('toxin', 'filler', 'skin', 'laser', 'threads', 'contour')),
  priced_by text not null check (priced_by in ('area', 'unit', 'syringe', 'thread', 'session')),
  fits text[] not null default '{}' check (cardinality(fits) between 1 and 60),
  units boolean not null default false,
  archived_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, key),
  -- Priced per unit means counted in units, or every entry would count as one.
  check (priced_by <> 'unit' or units)
);
create unique index if not exists aesthetic_treatments_name_idx
  on aesthetic_treatments (clinic_id, ar_normalize(name)) where archived_at is null;

create table if not exists aesthetic_treatment_variants (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  treatment_key text not null,
  name text not null check (length(name) between 1 and 60),
  name_ar text check (name_ar is null or length(name_ar) between 1 and 60),
  product_id uuid references aesthetic_products(id) on delete set null,
  sort integer not null default 0,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists aesthetic_treatment_variants_name_idx
  on aesthetic_treatment_variants (clinic_id, treatment_key, ar_normalize(name)) where active;
create index if not exists aesthetic_treatment_variants_clinic_idx on aesthetic_treatment_variants (clinic_id, treatment_key);

do $$ declare t text; begin
  foreach t in array array['aesthetic_treatments', 'aesthetic_treatment_variants'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I for all to clinicos_app
      using (app_is_admin() or clinic_id = app_clinic_id())
      with check (app_is_admin() or clinic_id = app_clinic_id())', t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;
