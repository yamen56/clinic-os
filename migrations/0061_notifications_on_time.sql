-- Notifications that arrive, arrive once, and arrive when they should.
--
-- Five changes, all about the same promise: that what a member of staff is
-- told reaches them, in the app and on the phone, at the moment it matters.

------------------------------------------------------------------------------
-- 1. A member may tell a colleague
------------------------------------------------------------------------------
/*
  The notifications policy only ever let a member write rows addressed to
  themselves, and most notifications are addressed to somebody else. Every
  caller that ran inside a member's own transaction and notified the rest of the
  team hit it:

    * signing in person on the clinic's tablet ("reception hears about every
      signature"),
    * a staff member declining a document they were asked to sign,
    * asking for a new signing link on a patient's behalf,
    * sending a document one of the doctors has to sign.

  Postgres refused the colleague's row, and because a refusal aborts the whole
  transaction, the signature, the decline or the send was rolled back with it.
  In a clinic with a single owner and nobody else, the only recipient was the
  person acting, so the bug stayed invisible exactly where it was tested.

  A policy widening INSERT is not enough, and was tried: every notification is
  written with ON CONFLICT (that is how "at most once" works), and ON CONFLICT
  also holds the new row to the SELECT policy — which must stay own-rows-only,
  because a colleague's notifications are theirs to read.

  So every notification goes through this one function. It runs with the
  table owner's rights and makes the only decision that matters itself: a
  member may address themselves, or a member of the clinic this transaction is
  acting for. Anybody else is skipped rather than refused — telling someone
  about a signature must never be the reason the signature is rolled back. The
  system context (the worker, public routes) may address anyone, as before.

  The check applies where row-level security does: to sessions logged in as
  `clinicos_app`. `session_user` is still the login role inside a security
  definer function. The owner role — migrations, operator scripts, the test
  suites — was never subject to RLS and is not held to this either; without
  that, every script that writes a notification over the owner connection would
  have been silently skipped.

  It also drops a kind the recipient switched off, in the same statement, so
  "off" costs nothing and never lands in their list.
*/
drop policy if exists notifications_colleague_insert on notifications;

create or replace function app_notify(
  p_clinic_id uuid,
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_url text,
  p_dedupe_key text,
  p_pref text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if session_user = 'clinicos_app' and not app_is_admin() and p_user_id is distinct from app_user_id() then
    if p_clinic_id is null
       or p_clinic_id is distinct from app_clinic_id()
       or not exists (
         select 1 from clinic_members where clinic_id = p_clinic_id and user_id = p_user_id
       ) then
      return;
    end if;
  end if;

  insert into notifications (clinic_id, user_id, kind, title, body, url, dedupe_key)
  select p_clinic_id, u.id, p_kind, p_title, coalesce(p_body, ''), p_url, p_dedupe_key
    from users u
   where u.id = p_user_id
     and (p_pref is null or coalesce(u.notification_prefs ->> p_pref, '') <> 'off')
  -- The index is partial (only keyed rows), so the predicate has to be
  -- repeated here or Postgres cannot infer which index this refers to.
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end $$;

revoke all on function app_notify(uuid, uuid, text, text, text, text, text, text) from public;
grant execute on function app_notify(uuid, uuid, text, text, text, text, text, text) to clinicos_app;

------------------------------------------------------------------------------
-- 2. Quiet hours
------------------------------------------------------------------------------
/*
  When a notification may be pushed to a phone, if that is later than when it
  was written. Set by the worker for somebody inside their quiet hours; the row
  itself is in the app immediately either way, so nothing is hidden, only kept
  off the lock screen until the morning.
*/
alter table notifications add column if not exists push_after timestamptz;

-- The worker asks "what has not been pushed yet" every five seconds. Partial, so
-- it stays the size of the backlog rather than of every notification ever sent.
create index if not exists notifications_unsent_idx on notifications (created_at)
  where not push_sent;

-- The header badge counts what is unread on every screen change, and the
-- worker counts it again for the app-icon badge on each push.
create index if not exists notifications_unread_idx on notifications (user_id)
  where read_at is null;

------------------------------------------------------------------------------
-- 3. Reading one on a phone clears the badge on the desk
------------------------------------------------------------------------------
/*
  The realtime event fired on insert only, so a notification read on one device
  stayed unread on every other open tab until it was reloaded — and the badge
  now in the header would have kept counting it.

  `update of read_at` so the worker marking rows as pushed does not wake anyone.
  The update event carries no row id on purpose: Postgres folds identical
  notifications raised in one transaction into one, so "mark all read" on five
  hundred rows is a single event to each open tab, not five hundred.
*/
create or replace function emit_notification() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform pg_notify('app_events', json_build_object(
      't', 'notifications', 'op', 'insert',
      'id', new.id, 'clinic_id', new.clinic_id, 'user_id', new.user_id
    )::text);
  else
    perform pg_notify('app_events', json_build_object(
      't', 'notifications', 'op', 'update',
      'clinic_id', new.clinic_id, 'user_id', new.user_id
    )::text);
  end if;
  return null;
end $$;
drop trigger if exists notifications_emit on notifications;
create trigger notifications_emit after insert or update of read_at on notifications
  for each row execute function emit_notification();

------------------------------------------------------------------------------
-- 4. More team alerts, chosen by who they are for
------------------------------------------------------------------------------
/*
  Instant ones, sent when something happens to an appointment:
    appointment_booked       a new appointment is on a doctor's list
    appointment_cancelled    one came off it
    appointment_rescheduled  one moved, or moved to another doctor
  For these three, as for the reminder, 'doctor' means the appointment's own
  doctor rather than every doctor in the clinic.

  Scheduled ones, at an hour in the clinic's own timezone:
    tomorrow_schedule        the evening before: each doctor's own list
    unconfirmed_tomorrow     reception: who still has to be called to confirm
    weekly_summary           the owner: the last seven days, on one weekday
*/
alter table clinic_staff_alerts drop constraint if exists clinic_staff_alerts_kind_check;
alter table clinic_staff_alerts add constraint clinic_staff_alerts_kind_check check (kind in (
  'appointment_reminder', 'day_schedule', 'day_end', 'unread_digest',
  'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
  'tomorrow_schedule', 'unconfirmed_tomorrow', 'weekly_summary'
));
-- weekly_summary only. ISO weekday, as Luxon counts it: 1 = Monday … 7 = Sunday.
alter table clinic_staff_alerts add column if not exists weekday smallint
  check (weekday is null or (weekday >= 1 and weekday <= 7));

/*
  Every clinic that exists gets the new ones, each kind at most once — a clinic
  that already has one of these kinds (none can, yet) keeps what it has.

  The evening preview is added switched off. Doctors already get their list at
  eight in the morning, and a second copy of the same list the night before is
  a choice for the clinic to make, not one to make for it. It is still there to
  switch on, which is the point of adding it.
*/
insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, weekday, threshold, enabled, sort)
select c.id, v.kind, v.roles, null, v.at_hour, v.weekday, 0, v.enabled, v.sort
from clinics c
cross join (values
  ('appointment_booked',      array['doctor']::text[],                  null::integer, null::smallint, true,  4),
  ('appointment_cancelled',   array['doctor']::text[],                  null,          null,           true,  5),
  ('appointment_rescheduled', array['doctor']::text[],                  null,          null,           true,  6),
  ('unconfirmed_tomorrow',    array['owner', 'receptionist']::text[],   17,            null,           true,  7),
  ('tomorrow_schedule',       array['doctor']::text[],                  20,            null,           false, 8),
  ('weekly_summary',          array['owner']::text[],                   9,             7::smallint,    true,  9)
) as v(kind, roles, at_hour, weekday, enabled, sort)
where not exists (
  select 1 from clinic_staff_alerts a where a.clinic_id = c.id and a.kind = v.kind
);

-- And every clinic created from now on starts with the full set.
create or replace function seed_clinic_staff_alerts() returns trigger
language plpgsql as $$
begin
  insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, weekday, threshold, enabled, sort)
  select new.id, v.kind, v.roles, v.minutes_before, v.at_hour, v.weekday, v.threshold, v.enabled, v.sort
  from (values
    ('appointment_reminder',    array['doctor']::text[],                null::integer, null::integer, null::smallint, 0, true,  0),
    ('day_schedule',            array['doctor']::text[],                null,          8,             null,           0, true,  1),
    ('day_end',                 array['owner']::text[],                 null,          20,            null,           0, true,  2),
    ('unread_digest',           array['owner', 'receptionist']::text[], null,          12,            null,           3, true,  3),
    ('appointment_booked',      array['doctor']::text[],                null,          null,          null,           0, true,  4),
    ('appointment_cancelled',   array['doctor']::text[],                null,          null,          null,           0, true,  5),
    ('appointment_rescheduled', array['doctor']::text[],                null,          null,          null,           0, true,  6),
    ('unconfirmed_tomorrow',    array['owner', 'receptionist']::text[], null,          17,            null,           0, true,  7),
    ('tomorrow_schedule',       array['doctor']::text[],                null,          20,            null,           0, false, 8),
    ('weekly_summary',          array['owner']::text[],                 null,          9,             7::smallint,    0, true,  9)
  ) as v(kind, roles, minutes_before, at_hour, weekday, threshold, enabled, sort)
  where not exists (select 1 from clinic_staff_alerts a where a.clinic_id = new.id);
  return new;
end $$;

------------------------------------------------------------------------------
-- 5. A reminder follows its appointment when it moves
------------------------------------------------------------------------------
/*
  The reminder's at-most-once key was the appointment alone, so an appointment
  moved after its reminder had gone out was never reminded again at its new
  time — the doctor was told about 10:00 and then heard nothing about 15:00.
  The key now carries the start time as well.

  Rewriting the keys already sent is what stops the change itself from sending
  anything: a reminder that went out in the last two days keeps its place under
  the new shape, so the worker finds it claimed and stays quiet.

  Two shapes exist: the personal-setting reminder
      doctor_reminder:<appointment>:<user>
  and one from an alert with its own lead time
      doctor_reminder:<alert>:<appointment>:<user>
*/
update notifications n
   set dedupe_key = 'doctor_reminder:' || split_part(n.dedupe_key, ':', 2)
                    || '@' || floor(extract(epoch from a.starts_at))::bigint
                    || ':' || split_part(n.dedupe_key, ':', 3)
  from appointments a
 where n.kind = 'doctor_reminder'
   and n.created_at > now() - interval '2 days'
   and n.dedupe_key not like '%@%'
   and array_length(string_to_array(n.dedupe_key, ':'), 1) = 3
   and a.id::text = split_part(n.dedupe_key, ':', 2);

update notifications n
   set dedupe_key = 'doctor_reminder:' || split_part(n.dedupe_key, ':', 2)
                    || ':' || split_part(n.dedupe_key, ':', 3)
                    || '@' || floor(extract(epoch from a.starts_at))::bigint
                    || ':' || split_part(n.dedupe_key, ':', 4)
  from appointments a
 where n.kind = 'doctor_reminder'
   and n.created_at > now() - interval '2 days'
   and n.dedupe_key not like '%@%'
   and array_length(string_to_array(n.dedupe_key, ':'), 1) = 4
   and a.id::text = split_part(n.dedupe_key, ':', 3);
