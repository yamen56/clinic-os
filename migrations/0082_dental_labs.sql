------------------------------------------------------------------------------
-- Dental labs, and the work sent to them
--
-- Yamen, 2026-10-17: "we want to have a place for dental lab when its needed
-- for the treatment ... some clinics have the dental lab inside of their
-- clinic and some of them work with multiple independent labs".
--
--   dental_labs        the clinic's labs: its own, in-house, or any number
--                      outside.
--   dental_lab_prices  what each lab charges for a treatment, by kind (a
--                      zirconia crown, an E-max one). One lab's zirconia
--                      crown is not another's.
--   lab_cases          a treatment's work at a lab: sent, due back, received,
--                      and what it cost. A remake is a second case.
--
-- A case's cost is the treatment's lab cost. It comes into the doctor's share
-- by the doctor's deal (0081), read live, because a lab's price is often
-- settled after the work was billed. It is locked once the lab is paid for it.
-- Paying a lab is an expense (0050, category 'lab'); the cases it paid point at
-- it, and deleting that expense puts them back to unpaid.
--
-- An in-house lab is never "owed": its technician is on the payroll. Its price
-- is still what the work cost, for the doctor's share.
------------------------------------------------------------------------------

create table if not exists dental_labs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  phone text not null default '',
  in_house boolean not null default false,
  note text not null default '' check (length(note) <= 500),
  active boolean not null default true,
  sort integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dental_labs_clinic_idx on dental_labs (clinic_id, active, sort);

create table if not exists dental_lab_prices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  lab_id uuid not null references dental_labs(id) on delete cascade,
  chart_key text not null,
  chart_variant text,
  cost numeric(12,2) not null check (cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists dental_lab_prices_key_idx
  on dental_lab_prices (lab_id, chart_key, coalesce(chart_variant, ''));

create table if not exists lab_cases (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  -- Carried so a change announces whose chart it is on (emit_patient_change).
  patient_id uuid not null references patients(id) on delete cascade,
  mark_id uuid not null references chart_marks(id) on delete cascade,
  -- Archived, never deleted, while work it did is on record.
  lab_id uuid not null references dental_labs(id) on delete restrict,
  cost numeric(12,2) not null check (cost >= 0),
  status text not null default 'sent' check (status in ('sent', 'received', 'cancelled')),
  sent_on date not null,
  due_on date,
  received_at timestamptz,
  shade text not null default '' check (length(shade) <= 40),
  note text not null default '' check (length(note) <= 1000),
  -- The expense that paid the lab for it. Null: not paid yet (or in-house).
  expense_id uuid references expenses(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lab_cases_open_idx on lab_cases (clinic_id, status, due_on);
create index if not exists lab_cases_mark_idx on lab_cases (mark_id);
create index if not exists lab_cases_unpaid_idx on lab_cases (lab_id) where expense_id is null and status <> 'cancelled';
create index if not exists lab_cases_patient_idx on lab_cases (clinic_id, patient_id);

------------------------------------------------------------------------------
-- RLS and updated_at, matching every other tenant-scoped table; a lab case
-- also tells its patient's open file it changed.
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['dental_labs', 'dental_lab_prices', 'lab_cases'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

drop trigger if exists lab_cases_emit on lab_cases;
create trigger lab_cases_emit after insert or update or delete on lab_cases
  for each row execute function emit_patient_change();
