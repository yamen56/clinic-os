-- A clinic's own colour for each face treatment, and the built-in ones it removed.
--
-- Yamen, 2026-11-08: "I want to be able to change the colours of the treatments and
-- delete them". A treatment's dots were drawn in its family's colour, so a toxin and
-- a skin booster could not be told apart by doctors who wanted them apart; and the
-- built-in list could not be shortened to what a clinic does.
--
-- One row per treatment a clinic changed, built-in or its own. A removed built-in is
-- hidden from the pickers and refused for new work, never forgotten: past entries
-- name it, and it can be brought back. (The clinic's own treatments are removed by
-- their own archived_at, as before.)

create table if not exists aesthetic_treatment_looks (
  clinic_id uuid not null references clinics(id) on delete cascade,
  treatment_key text not null,
  color text check (color is null or color ~ '^#[0-9a-f]{6}$'),
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, treatment_key)
);

alter table aesthetic_treatment_looks enable row level security;
drop policy if exists tenant_isolation on aesthetic_treatment_looks;
create policy tenant_isolation on aesthetic_treatment_looks for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());
drop trigger if exists aesthetic_treatment_looks_touch on aesthetic_treatment_looks;
create trigger aesthetic_treatment_looks_touch before update on aesthetic_treatment_looks
  for each row execute function touch_updated_at();
