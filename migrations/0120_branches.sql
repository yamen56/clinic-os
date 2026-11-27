------------------------------------------------------------------------------
-- Branches: a clinic's other workspaces, grouped under one owner
--
-- Yamen, 2026-11-27: a clinic can have several branches, and it is optional.
-- He chose separate workspaces rather than locations inside one: each branch
-- has its own patients, WhatsApp number, staff and booking link. What makes
-- them one clinic is this group — the owner moves between them on one login
-- and sees them side by side (src/lib/branches.ts).
--
-- A clinic with no group is a single location, exactly as before.
------------------------------------------------------------------------------

create table if not exists clinic_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_ar text,
  created_at timestamptz not null default now()
);

alter table clinics add column if not exists group_id uuid references clinic_groups(id) on delete set null;
create index if not exists clinics_group_idx on clinics (group_id) where group_id is not null;

-- Agency-written; a clinic reads its own group's name (the switcher and the report title).
alter table clinic_groups enable row level security;
drop policy if exists clinic_groups_admin on clinic_groups;
create policy clinic_groups_admin on clinic_groups for all to clinicos_app
  using (app_is_admin()) with check (app_is_admin());
drop policy if exists clinic_groups_read on clinic_groups;
create policy clinic_groups_read on clinic_groups for select to clinicos_app
  using (exists (select 1 from clinics cl where cl.group_id = clinic_groups.id and cl.id = app_clinic_id()));
