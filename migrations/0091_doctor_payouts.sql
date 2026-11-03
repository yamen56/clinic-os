-- What the clinic has paid its doctors, month by month.
--
-- Yamen, 2026-11-03: "Doctor payouts that can be marked as paid". The earnings
-- screen (0049) said what each doctor earned in a month and nothing more, so
-- whether they had been handed it lived in the owner's head or a notebook, and
-- the doctor had only the owner's word that last month was settled.
--
-- One row per payment to a doctor, for the month it pays for. Not a status on
-- the month: a share is often paid in two goes, or paid and then grows (a late
-- instalment, a lab bill corrected), and "paid" has to be able to say "paid 200
-- of 450". What is still owed is always the month's earnings, read live as the
-- earnings screen reads them, less what these rows add up to.
--
-- Not an expense. The doctors' share is already taken off what the clinic kept
-- (lib/earnings, clinicProfit); writing the payout to Expenses as well would
-- take it off twice. A salary is the other way round: it is a repeating
-- Salaries bill (0086) and has no row here.
--
-- Like the rate itself, what a colleague was paid is not RLS's to hide from the
-- rest of the clinic: the owner's payout table and a doctor's own month are the
-- only queries that select it.

create table if not exists doctor_payouts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  -- Cascade, as on invoice_line_doctors: a member deleted outright takes their
  -- arrangement with them. Deactivating one, the ordinary case, keeps it.
  doctor_member_id uuid not null references clinic_members(id) on delete cascade,
  -- The month it pays for, as its first day in the clinic's own calendar.
  period date not null check (extract(day from period) = 1),
  amount numeric(12, 2) not null check (amount > 0),
  -- A calendar day, like expenses.spent_on: the day the money changed hands.
  paid_on date not null,
  method text not null default 'cash' check (method in ('cash', 'cliq', 'transfer', 'cheque')),
  note text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists doctor_payouts_period_idx on doctor_payouts (clinic_id, period);
create index if not exists doctor_payouts_doctor_idx on doctor_payouts (clinic_id, doctor_member_id, period);

comment on table doctor_payouts is
  'Money handed to a doctor for a month''s share or on-call visits. Owed = that month''s earnings (lib/earnings) less these. Never an expense.';

do $$
declare t text;
begin
  foreach t in array array['doctor_payouts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;
