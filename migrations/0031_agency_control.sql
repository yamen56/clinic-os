-- Three things the agency panel could not do, and one it could do too easily.
--
--   1. Sell a clinic a subset of the product.
--   2. Let somebody help run the agency without handing them everything.
--   3. Remove a clinic — and take that back, because the first person to press
--      it will press it by accident.
--
-- All three are stored as jsonb maps rather than columns or join tables, for
-- the same reason `clinic_members.permissions` is: the set of things you can
-- switch on and off changes every time a feature ships, and a schema change per
-- feature is a schema change nobody makes, so the switches quietly stop
-- covering the product.

------------------------------------------------------------------------------
-- 1. What a clinic bought
------------------------------------------------------------------------------

-- An absent key means "on". That is what makes this migration safe to run on a
-- live database: every clinic that exists right now has `{}` and therefore
-- keeps the entire product, exactly as before. Only an explicit false takes
-- something away, and only the agency can write one.
alter table clinics
  add column if not exists features jsonb not null default '{}';

comment on column clinics.features is
  'Modules this clinic is licensed for, e.g. {"campaigns": false}. A missing key means enabled — see src/lib/features.ts. Intersected with each member''s own capabilities at session time, so a disabled module is invisible to the owner too.';

------------------------------------------------------------------------------
-- 2. Agency staff who are not the whole agency
------------------------------------------------------------------------------

-- `is_super_admin` keeps its meaning: it is the key to the admin panel. This
-- says what you may do once inside, in the same shape as a clinic member's
-- permissions ({"level":"custom","caps":{…}}).
--
-- `{}` resolves to full access, which is the only defensible default for a
-- column added under the feet of the people who already run the platform.
alter table users
  add column if not exists admin_permissions jsonb not null default '{}';

comment on column users.admin_permissions is
  'Agency-panel access for a super admin. {} or {"level":"full"} = everything (the pre-existing behaviour). {"level":"custom","caps":{…}} = only what is ticked — see src/lib/admin-permissions.ts.';

------------------------------------------------------------------------------
-- 3. Deleting a clinic, reversibly
------------------------------------------------------------------------------

-- Every foreign key into `clinics` cascades — all 49 of them — so a real delete
-- takes the patients, the appointments, the signed documents and the invoices
-- with it, instantly and without a copy anywhere. That is the correct
-- behaviour for a clinic that has genuinely left, and a catastrophe for a
-- mis-click, and the two are the same button.
--
-- So the button sets this instead. The clinic goes dark immediately — nobody
-- can sign in, WhatsApp disconnects, automations stop — but every row is still
-- there, and `restore` is one update. The worker performs the irreversible
-- delete once the window has passed.
alter table clinics
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references users(id) on delete set null;

comment on column clinics.deleted_at is
  'Set when the agency deletes the clinic. The workspace is locked from this moment; the rows survive until the worker purges them (see PURGE_AFTER_DAYS in worker/scheduler.ts). Null for every live clinic.';

-- Partial, because the interesting set is tiny and every hot query on this
-- table wants the other side of it: `where deleted_at is null`.
create index if not exists clinics_deleted_idx on clinics (deleted_at) where deleted_at is not null;
