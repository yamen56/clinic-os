-- Insurance, and a waitlist that turns cancellations back into appointments.
--
-- Two features, one migration, because both are additive and neither can be
-- half-applied usefully.

------------------------------------------------------------------------------
-- Insurers
------------------------------------------------------------------------------
-- Per clinic rather than global: the companies a clinic deals with are a short,
-- specific list it maintains itself, and one clinic's spelling of a name is not
-- another's problem.
create table if not exists insurers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  -- What reception actually types into the insurer's own portal. Kept beside the
  -- name because the two are almost never the same string.
  code text not null default '',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, name)
);
create index if not exists insurers_clinic_idx on insurers (clinic_id) where active;

alter table patients
  add column if not exists insurer_id uuid references insurers(id) on delete set null,
  add column if not exists insurance_no text not null default '',
  add column if not exists insurance_valid_until date;

/*
  The money split, on the invoice.

  `insurer_amount` is what the company is expected to cover and `total` stays the
  full price, so the patient's share is total - insurer_amount and never needs
  storing twice. Reception's question at the desk is "how much does this person
  pay right now", and that is the number this makes answerable.
*/
alter table invoices
  add column if not exists insurer_id uuid references insurers(id) on delete set null,
  add column if not exists insurer_amount numeric(12,2) not null default 0,
  -- Where the claim has got to. 'none' is the common case: most visits are cash.
  add column if not exists claim_status text not null default 'none'
    check (claim_status in ('none', 'to_submit', 'submitted', 'approved', 'rejected', 'paid')),
  add column if not exists claim_ref text not null default '',
  add column if not exists claim_submitted_at timestamptz,
  add column if not exists claim_note text not null default '';

-- The claims worklist is "everything not settled", so it is read by status.
create index if not exists invoices_claim_idx on invoices (clinic_id, claim_status)
  where claim_status <> 'none';

------------------------------------------------------------------------------
-- Waitlist
------------------------------------------------------------------------------
/*
  Patients who want an earlier appointment than they were given.

  A cancelled slot is money that evaporates quietly: nobody is told, and the hour
  simply passes empty. This is the list of people who would have taken it.

  `doctor_member_id` and `service_id` are both nullable, and null means "anyone"
  / "anything" rather than unknown — most people waiting are waiting for a
  particular doctor, but not all of them are.
*/
create table if not exists waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  doctor_member_id uuid references clinic_members(id) on delete set null,
  service_id uuid references services(id) on delete set null,
  -- The window they can actually come in. Null means no bound on that side.
  earliest_date date,
  latest_date date,
  note text not null default '',
  status text not null default 'waiting'
    check (status in ('waiting', 'offered', 'booked', 'cancelled', 'expired')),
  -- Set while an offer is outstanding, so the same person is not pestered about
  -- every slot that opens in the same hour.
  last_offered_at timestamptz,
  offers_sent integer not null default 0,
  booked_appointment_id uuid references appointments(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists waitlist_clinic_status_idx
  on waitlist_entries (clinic_id, status, created_at);
-- One live entry per patient per doctor: adding somebody twice is a mistake, not
-- a preference, and it would double every offer they receive.
create unique index if not exists waitlist_one_live_per_patient
  on waitlist_entries (clinic_id, patient_id, coalesce(doctor_member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('waiting', 'offered');

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
-- Same idiom as 0008, including the role the policy is granted to: without
-- `to clinicos_app` the policy exists but the app role is not the one it applies
-- to, and every query returns nothing.
do $$
declare t text;
begin
  foreach t in array array['insurers', 'waitlist_entries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

-- The waitlist is watched while reception works through it, and an offer landing
-- should appear without a refresh — same as campaigns.
drop trigger if exists waitlist_entries_emit on waitlist_entries;
create trigger waitlist_entries_emit after insert or update or delete on waitlist_entries
  for each row execute function emit_change();
