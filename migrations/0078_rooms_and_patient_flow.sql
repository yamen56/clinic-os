/*
  Rooms, and the patient's way through the clinic on the day.

  ROOMS. A clinic has two dentists and one X-ray room, or three doctors and two
  consulting rooms: the doctor was never the only thing an appointment takes.
  Until now two bookings could land in the same room at the same hour and
  nobody found out until both patients were standing in the corridor. A room is
  now booked the way a doctor is — the clinic-wide advisory lock in
  lockClinicSchedule covers it, exactly as it covers doctors, so no exclusion
  constraint is needed.

  Rooms are optional. A clinic with no active room behaves exactly as before
  everywhere: no room is picked, nothing is blocked, nothing is shown.

  `clinic_room_services` says which services a room can host. No rows means any
  service — the same rule as `service_doctors`. A service no room offers is not
  made unbookable; it simply takes no room (the Rooms page warns about it).

  THE DAY. `status` keeps its six values. Thirty places read it — reminders,
  automations, the waitlist, the devices worklist, analytics — and an "arrived"
  status would have to be taught to every one of them. Worse, moving a patient
  to `confirmed` because they walked in would fire the consent forms and the
  "your appointment is confirmed" WhatsApp at someone already sitting in the
  waiting room. So the day is kept in timestamps, and the stage is derived:
  arrived_at → in the waiting room, seated_at → in a room with the doctor,
  finished_at (with status completed) → done.

  `flow_prev_status` is what Finish replaced, so Undo can put it back.
  `walk_in` marks a visit created at the desk for someone already standing
  there: no "your appointment is booked" message, no booking alert, and their
  waitlist entries stay open.
*/

create table if not exists clinic_rooms (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  name_ar text check (name_ar is null or length(name_ar) <= 60),
  color text not null default '#4a6b8a' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists clinic_rooms_name_live on clinic_rooms (clinic_id, lower(name)) where active;
create index if not exists clinic_rooms_clinic_idx on clinic_rooms (clinic_id, sort) where active;

create table if not exists clinic_room_services (
  room_id uuid not null references clinic_rooms(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  primary key (room_id, service_id)
);
create index if not exists clinic_room_services_service_idx on clinic_room_services (service_id);

-- The room a doctor usually works in: preferred when one is picked for them.
alter table clinic_members add column if not exists default_room_id uuid references clinic_rooms(id) on delete set null;

alter table appointments
  add column if not exists room_id uuid references clinic_rooms(id) on delete set null,
  add column if not exists arrived_at timestamptz,
  add column if not exists seated_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists walk_in boolean not null default false,
  add column if not exists flow_prev_status text;

alter table appointments drop constraint if exists appointments_seated_needs_arrival;
alter table appointments add constraint appointments_seated_needs_arrival
  check (seated_at is null or arrived_at is not null);

create index if not exists appointments_room_time_idx on appointments (room_id, starts_at) where room_id is not null;

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['clinic_rooms', 'clinic_room_services'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

-- Touch and realtime on rooms only. The join table has no `id`, which
-- emit_change() reads; saving a room's services bumps the room's updated_at
-- instead, and that is the event the board hears.
drop trigger if exists clinic_rooms_touch on clinic_rooms;
create trigger clinic_rooms_touch before update on clinic_rooms
  for each row execute function touch_updated_at();
drop trigger if exists clinic_rooms_emit on clinic_rooms;
create trigger clinic_rooms_emit after insert or update or delete on clinic_rooms
  for each row execute function emit_change();
