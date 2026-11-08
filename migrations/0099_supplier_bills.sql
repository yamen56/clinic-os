-- What the clinic owes its suppliers (ذمم).
--
-- Yamen, 2026-11-08: "for the products and adding expenses there is something
-- called ذمم or debt — like I have 2000 in stock but I still didn't pay this
-- price, I want the system to be able to calculate it". Until now receiving
-- stock recorded the money as spent the same day (0085), and an expense was
-- always money already paid, so goods taken on credit had nowhere to be owed.
--
-- A bill is what is owed: to whom, how much, since when, and by when. Paying it
-- — in one go or in parts — writes an ordinary expense on the day the money
-- leaves, pointing back at the bill (`expenses.bill_id`). So Expenses stays
-- what it has always been, money that left, and the clinic's profit counts the
-- delivery when it is paid for, exactly as it counts a lab's bill (0082). What
-- is still owed is never stored: it is the bill less the expenses paid toward
-- it, so deleting a payment in Expenses makes the bill owed again on its own.
--
-- A delivery taken on credit carries its bill (`stock_batches.bill_id`) in
-- place of an expense.

create table if not exists supplier_bills (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  -- The supplier, when it is one of the clinic's stock companies; otherwise who
  -- is owed is only the name typed.
  company_id uuid references aesthetic_companies(id) on delete set null,
  vendor text not null default '' check (length(vendor) <= 120),
  category_id uuid references expense_categories(id) on delete set null,
  amount numeric(12, 2) not null check (amount > 0),
  -- The day the goods came or the bill arrived. A calendar day, like spent_on.
  incurred_on date not null,
  due_on date,
  note text not null default '' check (length(note) <= 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supplier_bills_clinic_idx on supplier_bills (clinic_id, incurred_on);

comment on table supplier_bills is
  'Money owed to a supplier (ذمم). Owed = amount less the expenses whose bill_id points here. Paying writes those expenses.';

alter table expenses
  add column if not exists bill_id uuid references supplier_bills(id) on delete set null;
create index if not exists expenses_bill_idx on expenses (bill_id) where bill_id is not null;

alter table stock_batches
  add column if not exists bill_id uuid references supplier_bills(id) on delete set null;
create index if not exists stock_batches_bill_idx on stock_batches (bill_id) where bill_id is not null;

do $$
declare t text;
begin
  foreach t in array array['supplier_bills'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;
