------------------------------------------------------------------------------
-- The face chart's products, stock and packages
--
-- Yamen, 2026-10-28, approving plan linear-cascade: a treatment that bills 100
-- may have used 50 of product (Botox from Allergan, a Juvederm syringe), the
-- doctor can add companies and products, stock is counted from the first
-- version, and clinics sell packages — "complete the rest, just do not do the
-- full body".
--
-- Products and stock
--
--   aesthetic_companies  who the clinic buys from.
--   aesthetic_products   what it buys: the treatments it is used in, the unit
--                        it is counted in (a 100u vial is counted in units, a
--                        filler in syringes), how many units a pack holds, and
--                        when to warn that it is running low.
--   stock_batches        each delivery: lot, expiry, units, what one unit cost.
--                        Receiving stock records the expense (category
--                        Supplies) in the same step, so the clinic's profit
--                        counts the money once — the cost on a treatment only
--                        decides its doctor's share.
--   stock_moves          every unit in and out: received, used on a treatment
--                        (the batch that expires first goes first), returned
--                        when the treatment is voided, adjusted with a reason.
--                        On hand is the sum. A treatment recorded with nothing
--                        on hand still records — it was already injected — as
--                        a move with no batch, at the product's last cost.
--   chart_mark_products  what a treatment used, and what that cost, frozen.
--                        It comes off the doctor's share by their deal, like
--                        lab work (earnings.ts).
--
-- A treatment's price can depend on the product, as a crown's does on its
-- material: a service with chart_key the treatment and chart_variant the
-- product's id. No new column — it is the one price list.
--
-- Packages
--
--   package_plans, package_plan_items   what the clinic sells: "Laser, upper
--                        lip × 6" (one item, six sessions) or a bundle (toxin
--                        once and a filler once, for one price).
--   patient_packages, patient_package_items   one sold to a patient. Selling
--                        it is a face chart entry at the package's price
--                        (sale_mark_id), so it is billed through Ready to bill
--                        and the invoice builder like any other work. Each
--                        item's `value` is its share of the price.
--   chart_marks.package_item_id   a session done from a package: no new charge
--                        (fee 0). It earns its doctor the session's part of the
--                        package — item value ÷ sessions — at the deal frozen
--                        on it (commission_percent, costs_rule), as the package
--                        invoice is paid.
------------------------------------------------------------------------------

create table if not exists aesthetic_companies (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  phone text not null default '' check (length(phone) <= 40),
  note text not null default '' check (length(note) <= 500),
  active boolean not null default true,
  sort integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists aesthetic_companies_clinic_idx on aesthetic_companies (clinic_id, active, sort);

create table if not exists aesthetic_products (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  company_id uuid references aesthetic_companies(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 80),
  treatments text[] not null default '{}',
  unit text not null check (unit in ('u', 'ml', 'syringe', 'vial', 'thread', 'piece')),
  pack_size numeric(10, 2) not null default 1 check (pack_size > 0),
  low_stock numeric(12, 2) check (low_stock is null or low_stock >= 0),
  -- What one unit cost: the last delivery's, or typed before there was one.
  last_cost numeric(12, 4) check (last_cost is null or last_cost >= 0),
  active boolean not null default true,
  sort integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists aesthetic_products_clinic_idx on aesthetic_products (clinic_id, active, sort);

create table if not exists stock_batches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  product_id uuid not null references aesthetic_products(id) on delete restrict,
  lot text not null default '' check (length(lot) <= 40),
  expires_on date,
  received_on date not null,
  qty numeric(12, 2) not null check (qty > 0),
  unit_cost numeric(12, 4) not null check (unit_cost >= 0),
  expense_id uuid references expenses(id) on delete set null,
  note text not null default '' check (length(note) <= 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists stock_batches_product_idx on stock_batches (product_id, expires_on);

create table if not exists stock_moves (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  product_id uuid not null references aesthetic_products(id) on delete restrict,
  -- Null: used with nothing on hand.
  batch_id uuid references stock_batches(id) on delete cascade,
  kind text not null check (kind in ('receive', 'use', 'return', 'adjust')),
  qty numeric(12, 2) not null check (qty <> 0),
  unit_cost numeric(12, 4) not null default 0 check (unit_cost >= 0),
  mark_id uuid references chart_marks(id) on delete set null,
  reason text not null default '' check (length(reason) <= 300),
  by_user uuid references users(id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists stock_moves_product_idx on stock_moves (clinic_id, product_id, batch_id);
create index if not exists stock_moves_mark_idx on stock_moves (mark_id) where mark_id is not null;

create table if not exists chart_mark_products (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  mark_id uuid not null references chart_marks(id) on delete cascade,
  product_id uuid not null references aesthetic_products(id) on delete restrict,
  qty numeric(12, 2) not null check (qty > 0),
  cost numeric(12, 2) not null check (cost >= 0),
  created_at timestamptz not null default now()
);
create index if not exists chart_mark_products_mark_idx on chart_mark_products (mark_id);

create table if not exists package_plans (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  name_ar text not null default '' check (length(name_ar) <= 80),
  price numeric(12, 2) not null check (price >= 0),
  valid_months integer check (valid_months is null or valid_months between 1 and 60),
  active boolean not null default true,
  sort integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists package_plans_clinic_idx on package_plans (clinic_id, active, sort);

create table if not exists package_plan_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  plan_id uuid not null references package_plans(id) on delete cascade,
  treatment_key text not null,
  sessions integer not null check (sessions between 1 and 100),
  sort integer not null default 0
);
create index if not exists package_plan_items_plan_idx on package_plan_items (plan_id, sort);

create table if not exists patient_packages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  plan_id uuid references package_plans(id) on delete set null,
  -- As sold: renaming or repricing the plan never rewrites a sale.
  name text not null,
  name_ar text not null default '',
  price numeric(12, 2) not null check (price >= 0),
  expires_on date,
  -- The face chart entry that sold it, billed like any other work.
  sale_mark_id uuid not null unique references chart_marks(id) on delete cascade,
  sold_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists patient_packages_patient_idx on patient_packages (clinic_id, patient_id);

create table if not exists patient_package_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_package_id uuid not null references patient_packages(id) on delete cascade,
  treatment_key text not null,
  sessions integer not null check (sessions between 1 and 100),
  -- Its share of the package's price.
  value numeric(12, 2) not null check (value >= 0),
  sort integer not null default 0
);
create index if not exists patient_package_items_pkg_idx on patient_package_items (patient_package_id, sort);

alter table chart_marks
  add column if not exists package_item_id uuid references patient_package_items(id) on delete set null,
  add column if not exists commission_percent numeric(5, 2) check (commission_percent is null or commission_percent between 0 and 100),
  add column if not exists costs_rule text check (costs_rule is null or costs_rule in ('shared', 'doctor'));
create index if not exists chart_marks_package_item_idx on chart_marks (package_item_id) where package_item_id is not null;
comment on column chart_marks.commission_percent is
  'A package session: its doctor''s rate when it was done, frozen like invoice_line_doctors. Null on everything else.';

------------------------------------------------------------------------------
-- RLS and updated_at, matching every other tenant-scoped table; a patient's
-- package tells its open file it changed.
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['aesthetic_companies', 'aesthetic_products', 'stock_batches', 'stock_moves', 'chart_mark_products',
                           'package_plans', 'package_plan_items', 'patient_packages', 'patient_package_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
  foreach t in array array['aesthetic_companies', 'aesthetic_products', 'package_plans'] loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

drop trigger if exists patient_packages_emit on patient_packages;
create trigger patient_packages_emit after insert or update or delete on patient_packages
  for each row execute function emit_patient_change();
