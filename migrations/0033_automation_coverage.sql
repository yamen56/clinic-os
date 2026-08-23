-- Everything that sends on its own, in one place.
--
-- Three gaps closed together, because they are the same gap seen from three
-- angles: the automations page claimed to be where automatic messages live, and
-- it was only ever where *some* of them lived.
--
--   1. Messages the platform sends outside the automation engine — booking
--      confirmations, verification codes, signing links, waitlist offers,
--      invoices. A clinic could read them nowhere and change them nowhere.
--   2. Staff and doctor alerts, which were four hardcoded rules in the worker.
--   3. A clinic's specialty, so a new workspace arrives with the flows its own
--      field actually needs rather than the generic seven.

------------------------------------------------------------------------------
-- 1. Built-in message texts
------------------------------------------------------------------------------
/*
  A sparse override table, not a seeded copy.

  Only a clinic that has actually changed or switched off a built-in message
  gets a row here; everyone else falls through to the default in
  src/lib/system-messages.ts. That is deliberate, and it is what makes the
  registry safe to grow: a message added to the product next month is live for
  every existing clinic the moment it ships, with no backfill and no clinic
  silently stuck on last year's wording because a seed ran before the key
  existed.

  The two bodies are both stored because the language is chosen per send — a
  patient booking in English gets the English one, a document written in Arabic
  gets the Arabic one — so this is not a translation of the clinic's locale.
*/
create table if not exists clinic_system_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  key text not null,
  enabled boolean not null default true,
  body_ar text not null default '',
  body_en text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, key)
);

------------------------------------------------------------------------------
-- 2. Staff and doctor alerts
------------------------------------------------------------------------------
/*
  What the worker used to hold as four `if` statements.

  Rows, so a clinic can add a second appointment reminder at a different lead
  time, send the morning list to reception as well as the doctors, move the
  end-of-day summary off 20:00, or delete the ones it does not want — none of
  which was expressible before.

  `minutes_before` is null on purpose for the seeded appointment reminder: null
  means "each recipient's own setting", which is the per-member
  `reminder_minutes` the notifications page already writes. A number overrides
  it clinic-wide for that row. Keeping null as a real value is what lets the
  existing personal preference survive this change untouched.

  `roles` uses the same vocabulary as notify.staffInRoles, where 'owner' is a
  flag on the membership rather than a job title.
*/
create table if not exists clinic_staff_alerts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  kind text not null check (kind in ('appointment_reminder', 'day_schedule', 'day_end', 'unread_digest')),
  roles text[] not null default '{}',
  -- appointment_reminder only. null = whatever each recipient set for themselves.
  minutes_before integer check (minutes_before is null or (minutes_before >= 0 and minutes_before <= 1440)),
  -- digests only, in the clinic's own timezone.
  at_hour integer check (at_hour is null or (at_hour >= 0 and at_hour <= 23)),
  -- unread_digest only: stay quiet below this many unread conversations.
  threshold integer not null default 0,
  enabled boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clinic_staff_alerts_clinic_idx on clinic_staff_alerts (clinic_id, kind)
  where enabled;

/*
  Every clinic that already exists gets exactly what the worker was doing for it
  a minute ago — same lead time, same hours, same audiences. This migration must
  not change a single notification anybody receives; it only moves the decision
  somewhere they can see it.
*/
insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, threshold, sort)
select c.id, v.kind, v.roles, v.minutes_before, v.at_hour, v.threshold, v.sort
from clinics c
cross join (values
  ('appointment_reminder', array['doctor']::text[], null::integer, null::integer, 0, 0),
  ('day_schedule',         array['doctor']::text[], null,          8,              0, 1),
  ('day_end',              array['owner']::text[],  null,          20,             0, 2),
  ('unread_digest',        array['owner', 'receptionist']::text[], null, 12,        3, 3)
) as v(kind, roles, minutes_before, at_hour, threshold, sort)
where not exists (select 1 from clinic_staff_alerts a where a.clinic_id = c.id);

/*
  Every clinic gets the four, whoever created it.

  A trigger rather than a call in the creation path, which is the opposite of
  how seed_esign_defaults works, and deliberately so. Consent-form templates are
  a library a clinic reads; these four rows are the product's baseline behaviour,
  and a clinic missing them does not look broken — the doctors simply stop being
  reminded, and nobody finds out until somebody misses a patient. Anything that
  fails that quietly should not depend on a caller remembering.

  It fires only when the clinic has none, so deleting an alert you do not want is
  permanent. `seedStaffAlerts` in the application does the same thing and is now
  belt-and-braces.
*/
create or replace function seed_clinic_staff_alerts() returns trigger
language plpgsql as $$
begin
  insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, threshold, sort)
  select new.id, v.kind, v.roles, v.minutes_before, v.at_hour, v.threshold, v.sort
  from (values
    ('appointment_reminder', array['doctor']::text[], null::integer, null::integer, 0, 0),
    ('day_schedule',         array['doctor']::text[], null,          8,              0, 1),
    ('day_end',              array['owner']::text[],  null,          20,             0, 2),
    ('unread_digest',        array['owner', 'receptionist']::text[], null, 12,        3, 3)
  ) as v(kind, roles, minutes_before, at_hour, threshold, sort);
  return new;
end $$;

drop trigger if exists clinics_seed_staff_alerts on clinics;
create trigger clinics_seed_staff_alerts after insert on clinics
  for each row execute function seed_clinic_staff_alerts();

/*
  Don't send today's digest twice.

  The worker's claim key changes shape in this release: it was one key per
  clinic per kind per local day, and it is now one per *alert*, because a clinic
  may have two of the same kind at two different hours. On the day this deploys,
  a clinic whose end-of-day summary already went out at 20:00 would find the new
  key unclaimed and send it again.

  So: for every alert whose clinic has already claimed the old key for its own
  local today, claim the new one too. Tomorrow both keys are fresh and this has
  no further effect. The old kind names ('morning', 'unread') are spelled out
  because that is what is sitting in the jobs table.
*/
insert into jobs (clinic_id, kind, payload, status, dedupe_key)
select a.clinic_id, 'digest:' || a.kind, '{}'::jsonb, 'done',
       'digest:' || a.kind || ':' || a.id || ':' ||
         to_char((now() at time zone c.timezone)::date, 'YYYY-MM-DD')
from clinic_staff_alerts a
join clinics c on c.id = a.clinic_id
where a.kind <> 'appointment_reminder'
  and exists (
    select 1 from jobs j
     where j.dedupe_key =
       'digest:' ||
       (case a.kind when 'day_schedule' then 'morning'
                    when 'unread_digest' then 'unread'
                    else a.kind end) ||
       ':' || a.clinic_id || ':' ||
       to_char((now() at time zone c.timezone)::date, 'YYYY-MM-DD')
  )
on conflict (dedupe_key) do nothing;

------------------------------------------------------------------------------
-- 3. Specialty
------------------------------------------------------------------------------
/*
  'general' on both sides is the neutral value, and it means two different
  things by design: a clinic that is general practice, and a recipe that suits
  every clinic whatever it practises. A new clinic is given the general library
  plus the library for its own field, so choosing wrongly at creation costs a
  pack of disabled recipes and nothing else.

  Existing clinics default to 'general', which is what they already had.
*/
alter table clinics add column if not exists specialty text not null default 'general';
alter table recipe_templates add column if not exists specialty text not null default 'general';
create index if not exists recipe_templates_specialty_idx on recipe_templates (specialty) where active;

-- Which specialty pack a clinic's copy came from, so the admin page can show
-- what is installed and offer the rest without guessing from the name.
alter table automations add column if not exists recipe_specialty text not null default 'general';

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['clinic_system_messages', 'clinic_staff_alerts'] loop
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
