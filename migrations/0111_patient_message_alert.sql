-- 0111 (2026-11-21): a patient's WhatsApp message is a team alert of its own,
-- doctors can be on it, and no two team alerts do the same job.
--
-- Yamen: "notify the doctor when a message is sent on WhatsApp so they can
-- notify the team and respond immediately, and of course it should be
-- optional"; and "the notifications are done twice".
--
-- 1. The instant WhatsApp alert (0110) reached whoever could open the inbox and
--    nobody else, and appeared nowhere on the Team alerts tab — so it could not
--    be seen, aimed or switched off. It is a row now, like every other alert:
--      owner         the owner;
--      receptionist  whoever else answers the inbox;
--      doctor        each doctor, for their own patients — the doctor of the
--                    patient's next visit, else of their last — and every
--                    message for a doctor who answers the inbox.
--    On for all three. That is what the inbox's people already had, plus the
--    doctors who asked for it; the clinic unticks Doctors, or each doctor turns
--    "Patients' WhatsApp messages" off for themselves.
--
-- 2. Picking "Appointment booked → reception" in the editor made a second
--    "Appointment booked" row beside the doctors' one, and the tab listed the
--    same alert twice. Rows of one kind at the same time are one row now, with
--    everybody on it. Only switched-on rows are merged: a switched-off one was
--    a decision about those people.

alter table clinic_staff_alerts drop constraint if exists clinic_staff_alerts_kind_check;
alter table clinic_staff_alerts add constraint clinic_staff_alerts_kind_check check (kind in (
  'appointment_reminder', 'day_schedule', 'day_end', 'unread_digest',
  'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
  'tomorrow_schedule', 'unconfirmed_tomorrow', 'weekly_summary',
  'patient_message'
));

insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, weekday, threshold, enabled, sort)
select c.id, 'patient_message', array['owner', 'receptionist', 'doctor']::text[], null, null, null, 0, true, -1
from clinics c
where not exists (
  select 1 from clinic_staff_alerts a where a.clinic_id = c.id and a.kind = 'patient_message'
);

do $$
declare g record;
begin
  for g in
    select array_agg(id order by sort, created_at) as ids
      from clinic_staff_alerts
     where enabled
     group by clinic_id, kind, minutes_before, at_hour, weekday, threshold
    having count(*) > 1
  loop
    update clinic_staff_alerts
       set roles = (select array_agg(distinct r) from clinic_staff_alerts a, unnest(a.roles) r where a.id = any(g.ids))
     where id = g.ids[1];
    delete from clinic_staff_alerts where id = any(g.ids[2:]);
  end loop;
end $$;

-- Every clinic created from now on starts with it too.
create or replace function seed_clinic_staff_alerts() returns trigger
language plpgsql as $$
begin
  insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, weekday, threshold, enabled, sort)
  select new.id, v.kind, v.roles, v.minutes_before, v.at_hour, v.weekday, v.threshold, v.enabled, v.sort
  from (values
    ('patient_message',         array['owner', 'receptionist', 'doctor']::text[], null::integer, null::integer, null::smallint, 0, true, -1),
    ('appointment_reminder',    array['doctor']::text[],                null,          null,          null,           0, true,  0),
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
