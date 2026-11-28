------------------------------------------------------------------------------
-- Families
--
-- 2026-11-28. A mother brings her three children from one phone. A phone is
-- a patient's identity here (one number, one file), so the children were
-- added with no number at all — and then nothing tied them to her: searching
-- her number found only her, their reminders went nowhere, and paying for
-- all three was three trips through three files.
--
-- A family is a small group of patient files. Each member has a role in it
-- (parent, child, grandparent, other — said with their gender on screen) and
-- one member is the contact: the phone that whatever is sent to a member
-- without a number of their own goes to. Nobody's own number is replaced —
-- a teenager with a phone still gets their own reminders.
--
-- `patient_reach_phone` is that rule in one place, for every path that sends
-- a patient something.
------------------------------------------------------------------------------

create table if not exists patient_families (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  contact_patient_id uuid references patients(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table patients add column if not exists family_id uuid references patient_families(id) on delete set null;
alter table patients add column if not exists family_role text
  check (family_role is null or family_role in ('parent', 'child', 'grandparent', 'other'));
create index if not exists patients_family_idx on patients (family_id) where family_id is not null;

alter table patient_families enable row level security;
drop policy if exists tenant_isolation on patient_families;
create policy tenant_isolation on patient_families for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

grant select, insert, update, delete on patient_families to clinicos_app;

-- The number to reach a patient on: their own, else their family contact's.
create or replace function patient_reach_phone(p_id uuid) returns text
language sql stable as $$
  select coalesce(
           p.phone_e164,
           (select g.phone_e164
              from patient_families f
              join patients g on g.id = f.contact_patient_id
             where f.id = p.family_id and g.merged_into is null))
    from patients p
   where p.id = p_id
$$;

grant execute on function patient_reach_phone(uuid) to clinicos_app;
