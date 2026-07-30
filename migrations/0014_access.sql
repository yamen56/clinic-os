-- Access becomes two independent things: what someone *is*, and what they *may do*.
--
-- Until now one column carried both. `role` said 'owner' | 'doctor' |
-- 'receptionist', and every gate in the app read it directly — so "can open
-- invoices" was spelled `role <> 'doctor'` and "can manage staff" was spelled
-- `role = 'owner'`. That conflates a job title with a permission set, and it
-- leaves no way to answer the obvious request: this doctor should also see the
-- inbox, that receptionist should not touch invoices.
--
-- After this migration:
--
--   role      — the job. 'doctor' | 'receptionist' | 'other'. Still load-bearing
--               for scheduling: only a doctor has working hours, is bookable and
--               owns appointments. 'other' is the escape hatch for a nurse, an
--               accountant, a manager — someone who needs an account and an
--               access set but is not a clinician and not the front desk.
--
--   is_owner  — whether this membership owns the clinic. Not a job title, which
--               is why it could never live in `role`: the owner is also a doctor
--               or a receptionist. It grants full access permanently and is what
--               the worker notifies when something needs the person in charge.
--
--   permissions — {"level":"full"} or {"level":"custom","caps":{...}}. `full`
--               means everything, now and after the next feature ships, so an
--               owner does not have to revisit every member each release.
--
-- The seeding below reproduces today's behaviour exactly, member by member, so
-- nobody gains or loses a screen on deploy.

alter table clinic_members add column if not exists is_owner boolean not null default false;

update clinic_members set is_owner = true where role = 'owner';

-- `role` is a job title from here on, so it needs a value for the owners that
-- had none, and a check constraint that admits the new one.
alter table clinic_members drop constraint if exists clinic_members_role_check;

update clinic_members set role = 'other' where role = 'owner';

alter table clinic_members
  add constraint clinic_members_role_check check (role in ('doctor', 'receptionist', 'other'));

create index if not exists clinic_members_owner_idx on clinic_members (clinic_id) where is_owner;

------------------------------------------------------------------------------
-- Seed the access sets from the old role, preserving current behaviour
------------------------------------------------------------------------------

-- Owners: everything, and everything future.
update clinic_members
   set permissions = '{"level":"full"}'::jsonb
 where is_owner;

-- Doctors: calendar, patients and documents — they countersign but never send,
-- and they have never had the inbox, invoices or settings. `automations` was
-- already a per-member flag, so it is carried across rather than reset.
update clinic_members
   set permissions = jsonb_build_object(
     'level', 'custom',
     'caps', jsonb_build_object(
       'conversations', false,
       'calendar', true,
       'patients', true,
       'documents', true,
       'documents.manage', false,
       'documents.void', false,
       'invoices', false,
       'campaigns', coalesce(permissions->>'automations', 'false')::boolean,
       'automations', coalesce(permissions->>'automations', 'false')::boolean,
       'settings', false,
       'settings.clinic', false,
       'settings.staff', false
     )
   )
 where not is_owner and role = 'doctor';

-- Receptionists: the front desk. Everything except the owner-only settings and
-- voiding a signed document.
update clinic_members
   set permissions = jsonb_build_object(
     'level', 'custom',
     'caps', jsonb_build_object(
       'conversations', true,
       'calendar', true,
       'patients', true,
       'documents', true,
       'documents.manage', true,
       'documents.void', false,
       'invoices', true,
       'campaigns', coalesce(permissions->>'automations', 'false')::boolean,
       'automations', coalesce(permissions->>'automations', 'false')::boolean,
       'settings', true,
       'settings.clinic', false,
       'settings.staff', false
     )
   )
 where not is_owner and role = 'receptionist';
