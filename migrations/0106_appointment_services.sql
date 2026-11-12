-- Several services on one appointment, and where a booking came from.
--
-- Yamen, 2026-11-12: "in the appointment creation give the ability to choose
-- multiple services, to make the doctor see that this patient will do more
-- than one service" — and "mention who created this appointment, or that it
-- came from the scheduling link".
--
-- 1. More than one service.
--
--    `appointments.service_id` stays, and stays the visit's first service:
--    its colour, its room, the reports by service and every automation already
--    read it, and none of them has to change to keep being right. What is new
--    is only the services after the first, kept here in the order they were
--    chosen. A visit with one service has no rows, so nothing is backfilled.
create table if not exists appointment_extra_services (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, service_id)
);
create index if not exists appointment_extra_services_appt_idx on appointment_extra_services (appointment_id, sort);
create index if not exists appointment_extra_services_service_idx on appointment_extra_services (service_id);

comment on table appointment_extra_services is
  'The services of a visit after its first (appointments.service_id), in the order chosen (0106).';

do $$
declare t text;
begin
  foreach t in array array['appointment_extra_services'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

--    What a visit is for, as one line: "Cleaning + Whitening". For every place
--    that only says it — a WhatsApp confirmation, a notification, a row on the
--    dashboard — so none of them joins two tables to write a name. Runs as the
--    caller, so row-level security applies to what it reads.
--
--    With `p_ar` each service gives its Arabic name where it has one, which is
--    what the readers' "Arabic name, else the name" already meant.
create or replace function appointment_service_names(p_appointment uuid, p_ar boolean default false) returns text
language sql stable as $$
  select string_agg(
           case when p_ar then coalesce(nullif(s.name_ar, ''), s.name) else s.name end,
           ' + ' order by x.ord)
    from (
      select a.service_id, 0 as ord from appointments a
       where a.id = p_appointment and a.service_id is not null
      union all
      select e.service_id, 1 + e.sort from appointment_extra_services e
       where e.appointment_id = p_appointment
    ) x
    join services s on s.id = x.service_id
$$;

-- 2. Where a booking came from.
--
--    Who made a staff booking has been stored all along (`created_by`) and was
--    never shown. A booking from the public page said only `source =
--    'booking_link'` — not which of the clinic's links, and a clinic with one
--    link at the desk and another in an advert wants to know. Null for every
--    booking made before this, and for a link since deleted.
alter table appointments
  add column if not exists booking_link_id uuid references booking_links(id) on delete set null;

comment on column appointments.booking_link_id is
  'The booking link this visit was booked through (0106). Null for staff, AI and automation bookings.';

-- 3. A booking link may let the patient choose more than one service.
--
--    Off unless the clinic turns it on for that link: a patient stacking four
--    services into one long slot is a decision about the clinic's diary, not a
--    default.
alter table booking_links
  add column if not exists allow_multiple_services boolean not null default false;
