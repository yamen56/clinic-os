-- How a member is paid: a percentage, a salary, or on call.
--
-- Yamen, 2026-10-28: "make sure that adding the staff like the doctor … align
-- well with all the needed fields like the percentage with the doctor unless
-- he have a salary or on call". A percentage was the only deal this product
-- knew (0049, `commission_percent`), and it could be set only after the member
-- existed. A doctor on a salary, or one called in and paid by the visit, had
-- nowhere to be written down, and the clinic's profit never heard of either.
--
-- One deal at a time, and which one it is is read off the columns — no
-- separate type column to drift from them:
--
--   percentage — `commission_percent` (0049), unchanged. Every QA fixture and
--                every query that asks "does this doctor take a share" keeps
--                asking it the same way.
--   salary     — `salary_amount` a month, paid on `salary_day`. It is the
--                clinic's spending, not a share of what it collects, so it
--                lives where the rent does: a repeating Salaries bill
--                (`expense_schedules`, 0050) that the staff screen keeps in
--                step, linked by `salary_schedule_id`.
--   on call    — `on_call_fee` for each visit they see through to the end
--                (an appointment marked completed). Earned on the visit's day,
--                at the fee frozen in `on_call_visits` when it was completed,
--                so changing the fee in March does not rewrite January — the
--                same rule as the percentage frozen on an invoice line.
--
-- The server clears the other two whenever one is set (settings/staff/pay.ts).
--
-- Like `commission_percent`, RLS does not protect these columns: members_access
-- lets every member read their colleagues' rows. The staff page selects them
-- only for the owner, and nothing else selects them for a screen.

alter table clinic_members
  add column if not exists salary_amount numeric(12, 2) check (salary_amount is null or salary_amount > 0),
  add column if not exists salary_day smallint check (salary_day is null or salary_day between 1 and 31),
  add column if not exists salary_schedule_id uuid references expense_schedules(id) on delete set null,
  add column if not exists on_call_fee numeric(12, 2) check (on_call_fee is null or on_call_fee >= 0);

comment on column clinic_members.salary_amount is
  'A monthly salary. Posted to Expenses by the repeating bill in salary_schedule_id, never counted as a share.';
comment on column clinic_members.on_call_fee is
  'Paid per completed visit. Frozen per visit in on_call_visits; null = not on call.';

------------------------------------------------------------------------------
-- The visits an on-call member is owed for
--
-- One row per completed appointment whose doctor was on call when it was
-- completed, written by the trigger below and by nothing else. A table of its
-- own rather than a column on `appointments`, because appointments are read by
-- everybody on the calendar and what a colleague is paid is not their business.
------------------------------------------------------------------------------
create table if not exists on_call_visits (
  appointment_id uuid primary key references appointments(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  doctor_member_id uuid not null references clinic_members(id) on delete cascade,
  visit_at timestamptz not null,
  fee numeric(12, 2) not null check (fee >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists on_call_visits_doctor_idx on on_call_visits (clinic_id, doctor_member_id, visit_at);
create index if not exists on_call_visits_clinic_idx on on_call_visits (clinic_id, visit_at);

do $$
declare t text;
begin
  foreach t in array array['on_call_visits'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

/*
  Completed with an on-call doctor → owed a visit; anything else → not.

  The fee is the doctor's on the moment the visit is completed, and kept from
  then on: an edit to the appointment's notes or time does not re-read it. A
  different doctor, or the visit un-completed and completed again, is a new
  visit and reads the fee again. A doctor who is not on call (or no doctor at
  all) owes nothing, so their visits write no row.
*/
create or replace function on_call_visit_sync() returns trigger language plpgsql as $$
declare fee numeric(12, 2);
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.doctor_member_id is not distinct from old.doctor_member_id
     and new.starts_at is not distinct from old.starts_at then
    return new;
  end if;

  if new.status <> 'completed' or new.doctor_member_id is null then
    delete from on_call_visits where appointment_id = new.id;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status = 'completed'
     and new.doctor_member_id is not distinct from old.doctor_member_id then
    -- Same visit, moved: keep its fee, follow its date.
    update on_call_visits set visit_at = new.starts_at where appointment_id = new.id;
    return new;
  end if;

  select cm.on_call_fee into fee from clinic_members cm
   where cm.id = new.doctor_member_id and cm.clinic_id = new.clinic_id;
  if fee is null then
    delete from on_call_visits where appointment_id = new.id;
    return new;
  end if;
  insert into on_call_visits (appointment_id, clinic_id, doctor_member_id, visit_at, fee)
  values (new.id, new.clinic_id, new.doctor_member_id, new.starts_at, fee)
  on conflict (appointment_id) do update
    set doctor_member_id = excluded.doctor_member_id, visit_at = excluded.visit_at, fee = excluded.fee;
  return new;
end $$;

drop trigger if exists appointments_on_call on appointments;
create trigger appointments_on_call after insert or update of status, doctor_member_id, starts_at on appointments
  for each row execute function on_call_visit_sync();
