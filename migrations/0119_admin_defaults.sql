------------------------------------------------------------------------------
-- The admin's plan prices, and the specialty automation packs retired
--
-- Yamen, 2026-11-27.
--
--   plan_defaults   one row per plan (lib/plans): the price a new clinic on it
--                   starts at, typed by the agency on Admin → Plans. Only a
--                   prefill — each clinic keeps its own `plan_price`, because
--                   prices are agreed clinic by clinic. Zero until set: no
--                   price is invented here.
--
--   recipe_templates the specialty packs ("I feel they are useless") leave the
--                   gallery. One stays: the psychiatry reminder, which replaces
--                   the day-before reminder with one that does not name the
--                   clinic — a patient's privacy, not a pack. A clinic already
--                   running a copy of a retired one keeps it; it is that
--                   clinic's own flow now. scripts/seed-recipes.ts leaves them
--                   out too, so a re-seed does not bring them back.
------------------------------------------------------------------------------

create table if not exists plan_defaults (
  plan text primary key check (plan in ('doctor', 'clinic_plus', 'clinic_pro')),
  price numeric(10, 2) not null default 0 check (price >= 0),
  currency text not null default 'JOD',
  updated_at timestamptz not null default now()
);

insert into plan_defaults (plan) values ('doctor'), ('clinic_plus'), ('clinic_pro')
on conflict (plan) do nothing;

-- Agency-only: read and written through withSystem (app.is_admin), never by a clinic.
alter table plan_defaults enable row level security;
drop policy if exists plan_defaults_admin on plan_defaults;
create policy plan_defaults_admin on plan_defaults for all to clinicos_app
  using (app_is_admin()) with check (app_is_admin());

update recipe_templates
   set active = false
 where specialty <> 'general'
   and key <> 'psych_discreet_reminder'
   and active;
