------------------------------------------------------------------------------
-- What the clinic spends
--
-- This product has always known exactly what a clinic takes in and nothing at
-- all about what it pays out. The only outflow it understood was a doctor's
-- commission, and even that is computed rather than recorded -- there is no row
-- anywhere representing money leaving. Which makes every "profit" figure a
-- half-truth: the earnings screen says "after doctor commission" and an owner
-- reads it as "what I kept", with rent, salaries and lab bills nowhere in it.
--
-- Three tables, and the split between the last two is the important one:
--
--   expense_categories  the clinic's own filing, seeded so it is never empty
--   expense_schedules   a RULE. "Rent, 400, the 1st of every month."
--   expenses            money that actually left, once.
--
-- A schedule is deliberately not an expense with a flag on it. Putting
-- `recurs`/`recur_day` on the expense row would mean every total in the product
-- has to remember to exclude the template, and the first query that forgets
-- double-counts the rent. Kept apart, "is this money that left?" is answered by
-- which table the row is in, and no reader has to know the rule exists.
--
-- Expenses attach to nothing else. Not to a doctor -- a purchase the clinic
-- made is not a deduction from somebody's pay, and tying the two would mean a
-- bill entered late silently moves a doctor's settled earnings. Not to a
-- patient, and not to a service section either: this is the clinic's money.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- The clinic's own filing
--
-- Seeded rather than empty, because an expense screen that opens with "create a
-- category first" is one nobody uses twice. `is_system` marks the seven every
-- clinic starts with, so the seed can stay idempotent after a clinic renames
-- them -- it is a provenance marker, not a lock. They are deletable like any
-- other: `expenses.category_id` is `on delete set null`, so removing one drops
-- its spend into the unfiled group rather than destroying it. note_categories
-- earned its undeletable rule because live notes already pointed at values that
-- had to survive a migration; nothing here has that history.
--
-- Modelled on note_categories (0037), which is the house pattern for a coloured
-- list the clinic curates but never starts without.
------------------------------------------------------------------------------
create table if not exists expense_categories (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  -- Stable handle for the seeded rows so re-running the seed is a no-op even
  -- after a clinic has renamed them. Null for anything a clinic adds itself.
  key text,
  name text not null check (length(btrim(name)) between 1 and 60),
  name_ar text,
  color text not null default '#6989a6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_system boolean not null default false,
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, key)
);
create index if not exists expense_categories_clinic_idx on expense_categories (clinic_id, sort);

------------------------------------------------------------------------------
-- The rule
--
-- `day_of_month` admits 1..31 and is clamped to the month's last day when it
-- fires. Capping the column at 28 was the first instinct and is worse: somebody
-- who means "end of month" picks 31, and 31 has to mean the 28th in February
-- rather than never firing at all.
--
-- `last_posted_on` is the whole concurrency story, and it is deliberately not a
-- clock gate. Every other daily job in this worker fires on an exact hour with
-- two minutes of slack, which is right for a reminder: a missed one is stale by
-- tomorrow anyway. Rent is not. And the tick is scheduled 60s *after* the
-- previous pass finishes, so its phase walks forward all day -- `dailyBackup`
-- carries a comment about precisely this ("a skipped minute was a skipped
-- day"). The same gate here would make a skipped minute a skipped *month*, and
-- nobody would notice until the books were short.
--
-- So the poster does a compare-and-swap instead:
--
--   update expense_schedules set last_posted_on = :due
--    where id = :id and active
--      and (last_posted_on is null or last_posted_on < :due)
--   returning ...
--
-- in the same transaction as the insert. One statement answers every case: two
-- workers race and exactly one wins; a restart mid-post rolls back both or
-- neither; a worker down across the due date still catches up on its next tick,
-- because `due <= today` is still true. The hour is then a courtesy, not a
-- correctness requirement.
------------------------------------------------------------------------------
create table if not exists expense_schedules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  category_id uuid references expense_categories(id) on delete set null,
  amount numeric(12,2) not null check (amount > 0),
  vendor text not null default '',
  note text not null default '',
  method text not null default 'transfer' check (method in ('cash', 'cliq', 'card', 'transfer', 'cheque')),
  day_of_month integer not null check (day_of_month between 1 and 31),
  active boolean not null default true,
  last_posted_on date,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expense_schedules_clinic_idx on expense_schedules (clinic_id, active);

comment on column expense_schedules.last_posted_on is
  'The local date this rule last produced an expense. Read as "have we done this
   month" so a missed hour does not skip the month entirely.';

------------------------------------------------------------------------------
-- Money that left
--
-- `amount > 0`, matching payments. An expense is an outflow by virtue of being
-- in this table; the direction is not a sign. A negative row would also render
-- as an invalid bar height in every chart that draws it.
--
-- `spent_on` is a date, not a timestamp -- the day written on the receipt, not
-- an instant. Readers must use fmtDateOnly: node-pg hands a `date` back as a JS
-- Date at the *server's* local midnight, and pushing that through a timezone
-- conversion moves it a day. Same reason invoices.issue_date exists.
--
-- `category_id` and `schedule_id` are both `on delete set null`: deleting a
-- category is a filing decision and deleting a rule is a scheduling one, and
-- neither is a statement that the money never left.
------------------------------------------------------------------------------
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  category_id uuid references expense_categories(id) on delete set null,
  schedule_id uuid references expense_schedules(id) on delete set null,
  amount numeric(12,2) not null check (amount > 0),
  vendor text not null default '',
  note text not null default '',
  spent_on date not null,
  method text not null default 'cash' check (method in ('cash', 'cliq', 'card', 'transfer', 'cheque')),
  -- The bill itself. Three columns rather than one because serving a file back
  -- safely needs its declared type and its original name, and neither can be
  -- recovered from a storage key: see lib/download, which refuses to render
  -- anything it does not recognise inline.
  receipt_path text,
  receipt_name text,
  receipt_mime text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The list and every total are "this clinic, this month", newest first.
create index if not exists expenses_clinic_idx on expenses (clinic_id, spent_on desc);
create index if not exists expenses_category_idx on expenses (clinic_id, category_id);

/*
  A backstop, not the authority.

  `last_posted_on` is what stops a rule posting twice; this index is the thing
  that catches it if that ever fails. It cannot be the authority on its own,
  because a user deleting a posted row frees the slot and the next tick would
  resurrect the rent they just deleted on purpose.
*/
create unique index if not exists expenses_schedule_month_idx
  on expenses (schedule_id, spent_on) where schedule_id is not null;

comment on table expenses is
  'Money the clinic spent. Attached to nothing but the clinic: not a doctor, not
   a patient, not a service section.';

------------------------------------------------------------------------------
-- The seven every clinic starts with
--
-- `on conflict (clinic_id, key) do nothing` so this is safe to re-run, and safe
-- after a clinic has renamed every one of them.
------------------------------------------------------------------------------
create or replace function seed_expense_categories(p_clinic uuid) returns void language plpgsql as $$
begin
  insert into expense_categories (clinic_id, key, name, name_ar, color, is_system, sort)
  values
    (p_clinic, 'rent',      'Rent',       'الإيجار',        '#6989a6', true, 10),
    (p_clinic, 'salaries',  'Salaries',   'الرواتب',        '#0f6e5c', true, 20),
    (p_clinic, 'supplies',  'Supplies',   'المستهلكات',     '#b07d3a', true, 30),
    (p_clinic, 'lab',       'Lab',        'المختبر',        '#7a5ea8', true, 40),
    (p_clinic, 'utilities', 'Utilities',  'الخدمات',        '#3a7fb0', true, 50),
    (p_clinic, 'marketing', 'Marketing',  'التسويق',        '#b0503a', true, 60),
    (p_clinic, 'other',     'Other',      'أخرى',           '#8a8f98', true, 70)
  on conflict (clinic_id, key) do nothing;
end $$;

-- Every clinic that already exists. New ones get them from provisionClinic,
-- which is the single provisioning path precisely so these two cannot drift.
do $$
declare c record;
begin
  for c in select id from clinics loop
    perform seed_expense_categories(c.id);
  end loop;
end $$;

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['expense_categories', 'expense_schedules', 'expenses'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

------------------------------------------------------------------------------
-- updated_at
--
-- Attached by hand. The loop in 0001 ran over the tables that existed when it
-- ran and has never run again, which is how service_sections went two
-- migrations with a frozen updated_at before 0049 noticed.
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['expense_categories', 'expense_schedules', 'expenses'] loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format(
      'create trigger %I before update on %I for each row execute function touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;
