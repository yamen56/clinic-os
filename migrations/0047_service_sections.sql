------------------------------------------------------------------------------
-- Sections: the part of the clinic a service belongs to
--
-- Services are one flat list, which is right for a practice that does one
-- thing and wrong for the clinics this product is sold into. A place running
-- dentistry, pediatrics and aesthetics has thirteen services in a single
-- undifferentiated stack — in the settings screen, in the calendar's dropdown,
-- in the revenue chart, and worst of all on the public booking page, where a
-- parent booking a check-up scrolls past eight dental procedures to find it.
--
-- A section is the clinic's own division of itself: قسم الأسنان, قسم الأطفال.
-- It groups services and nothing else. It is not a doctor's specialty (one
-- doctor may work across two) and not a room.
--
-- Everything here is additive and nullable, and nothing is seeded. A clinic
-- with no sections must render exactly as it does today — no headings, no
-- extra booking step, no new filter — so this migration is inert until
-- somebody creates the first row. That is why there is no backfill: unlike
-- note_categories in 0037, which had to become rows because `kind` was already
-- hard-coded onto live notes, an empty list here is a complete and correct
-- state.
------------------------------------------------------------------------------

create table if not exists service_sections (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  name_ar text,
  color text not null default '#6989a6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists service_sections_clinic_idx on service_sections (clinic_id, sort);

alter table service_sections enable row level security;
drop policy if exists tenant_isolation on service_sections;
create policy tenant_isolation on service_sections for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

------------------------------------------------------------------------------
-- The service's side of it
--
-- `on delete set null`, not cascade. Deleting a section is a filing decision;
-- it must never take the services — and therefore the appointments, invoice
-- lines and consent documents pointing at them — with it. A deleted section
-- drops its services back into the unfiled group, which is visible on the
-- settings screen and fixable in a click.
------------------------------------------------------------------------------
alter table services
  add column if not exists section_id uuid references service_sections(id) on delete set null;

comment on column services.section_id is
  'The part of the clinic this service belongs to. Null means unfiled, which is
   every service until a clinic creates its first section.';

-- Covers the grouped list: the section, then the order within it.
create index if not exists services_section_idx on services (clinic_id, section_id, sort);

------------------------------------------------------------------------------
-- A link that is about one part of the clinic
--
-- `service_ids` already restricts a link to a hand-picked set. That set is a
-- snapshot: add a dental service next month and the dentistry link does not
-- know about it until somebody remembers to edit it. Pointing at a section
-- instead says what was meant — "this link is the dentistry page" — and picks
-- up new services in that section on its own.
--
-- The two are alternatives, not layers. The editor writes one and clears the
-- other, so a link can never carry a section and a service list that disagree.
-- No CHECK enforces it, for the same reason 0046 has none: the interesting
-- cases are about the services table, not about this row.
------------------------------------------------------------------------------
alter table booking_links
  add column if not exists section_id uuid references service_sections(id) on delete set null;

comment on column booking_links.section_id is
  'Restrict this link to one section, picking up its future services too.
   Mutually exclusive with service_ids; null means the restriction is off.';
