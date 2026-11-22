-- Patients change or cancel their own appointment (2026-11-22).
--
-- Until now every change went through reception: the day-before reminder's
-- "2" became a task to call the patient, and an online booking had no way back
-- to it once made. Each appointment now has a personal link (/v/<token>, an
-- HMAC of the appointment, nothing stored) where the patient can pick another
-- time or cancel, within the rules the clinic sets here.

------------------------------------------------------------------------------
-- 1. The clinic's rules
------------------------------------------------------------------------------
-- What a patient may do from the link: nothing (call us), cancel, or cancel
-- and change the time. New clinics get the whole thing; every clinic that
-- exists today starts switched off, because its patients were told to call.
alter table clinics add column if not exists patient_changes text not null default 'cancel_move';
alter table clinics drop constraint if exists clinics_patient_changes_check;
alter table clinics add constraint clinics_patient_changes_check
  check (patient_changes in ('off', 'cancel', 'cancel_move'));

-- How close to the visit the link stops changing it. Twelve hours by default:
-- the day-before reminder waits twelve hours for its reply, so every "2" in
-- that window still reaches the link rather than reception.
alter table clinics add column if not exists patient_changes_cutoff_hours integer not null default 12;
alter table clinics drop constraint if exists clinics_patient_changes_cutoff_check;
alter table clinics add constraint clinics_patient_changes_cutoff_check
  check (patient_changes_cutoff_hours between 0 and 168);

-- Existing clinics: off. Guarded by a marker so a re-run never switches a
-- clinic back off after it turned the feature on.
do $$
begin
  if not exists (select 1 from _migrations where name = '0115_patient_changes.sql') then
    update clinics set patient_changes = 'off';
  end if;
exception when undefined_table then
  update clinics set patient_changes = 'off';
end $$;

------------------------------------------------------------------------------
-- 2. What the patient did, on the appointment
------------------------------------------------------------------------------
-- Who cancelled it, so the desk can read "cancelled by the patient online"
-- instead of calling to ask. Set with the status, cleared when it is restored.
alter table appointments add column if not exists cancelled_by text;
alter table appointments drop constraint if exists appointments_cancelled_by_check;
alter table appointments add constraint appointments_cancelled_by_check
  check (cancelled_by is null or cancelled_by in ('patient', 'staff', 'automation'));
-- The reason the patient picked, if any (one of a few chips, or nothing).
alter table appointments add column if not exists cancel_reason text;
-- How many times the patient moved it from the link. Two, then "call us".
alter table appointments add column if not exists patient_moves integer not null default 0;

------------------------------------------------------------------------------
-- 3. The day-before reminders: "2" sends the link when the link can help
------------------------------------------------------------------------------
-- Each clinic's reminder is its own copy of the template. Where its "2" branch
-- is still the template's (it begins by flagging "يريد تغيير موعده"), a
-- condition goes in front of it: when the patient can change the visit online,
-- they get their link; otherwise the branch runs exactly as before. A clinic
-- that keeps the feature off therefore sees no change at all. A branch the
-- clinic rewrote is left alone. Idempotent: once rewired, the "2" edge leads to
-- the condition, which this no longer matches.
do $$
declare
  e record;
  cond_id uuid;
  send_id uuid;
  next_sort integer;
begin
  for e in
    select ed.id as edge_id, ed.clinic_id, ed.automation_id, ed.to_step_id, a.recipe_key
      from automation_edges ed
      join automations a on a.id = ed.automation_id
      join automation_steps w on w.id = ed.from_step_id and w.step_type = 'wait_for_reply'
      join automation_steps f on f.id = ed.to_step_id and f.step_type = 'flag_conversation'
     where a.recipe_key in ('reminder_24h', 'psych_discreet_reminder')
       and ed.handle = 'opt:1'
       and f.config->>'reason' = 'يريد تغيير موعده'
  loop
    cond_id := gen_random_uuid();
    send_id := gen_random_uuid();
    select coalesce(max(sort), 0) + 1 into next_sort from automation_steps where automation_id = e.automation_id;

    insert into automation_steps (id, clinic_id, automation_id, sort, step_type, config, label)
    values (
      cond_id, e.clinic_id, e.automation_id, next_sort, 'condition',
      '{"match":"all","rules":[{"kind":"patient_can_change","negate":false,"value":"","value2":"","values":[],"number":null,"number2":null,"key":"","op":"equals"}]}'::jsonb,
      ''
    );
    insert into automation_steps (id, clinic_id, automation_id, sort, step_type, config, label)
    values (
      send_id, e.clinic_id, e.automation_id, next_sort + 1, 'send_whatsapp',
      jsonb_build_object(
        'message',
        case when e.recipe_key = 'psych_discreet_reminder'
          then E'ولا يهمك 🙏\nاختر وقتاً آخر أو ألغِ الموعد من هنا:\n{{appointment.manage_link}}'
          else E'ولا يهمك 🙏\nاختر وقتاً جديداً أو ألغِ الموعد من هنا:\n{{appointment.manage_link}}'
        end,
        'media', null
      ),
      ''
    );
    update automation_edges set to_step_id = cond_id where id = e.edge_id;
    insert into automation_edges (clinic_id, automation_id, from_step_id, handle, to_step_id)
    values (e.clinic_id, e.automation_id, cond_id, 'yes', send_id),
           (e.clinic_id, e.automation_id, cond_id, 'no', e.to_step_id);
  end loop;
end $$;

-- The older one-message reminder ("…إذا احتجت تعديل الموعد راسلنا.") has no
-- reply to branch on, so its stock wording gains the link as a last line. The
-- line is dropped when the link is empty — every clinic with the feature off.
-- Only the exact stock wording: a reminder the clinic rewrote is theirs.
update automation_steps s
   set config = jsonb_set(
         s.config, '{message}',
         to_jsonb((s.config->>'message') || E'\nأو غيّره بنفسك من هنا: {{appointment.manage_link}}')
       )
  from automations a
 where a.id = s.automation_id
   and a.recipe_key = 'reminder_24h'
   and s.step_type = 'send_whatsapp'
   and s.config->>'message' = E'تذكير بموعدك غداً في {{clinic.name}} 🦷\n🕐 {{appointment.time}}\n{{appointment.service}}\n\nإذا احتجت تعديل الموعد راسلنا.';

-- The same for reception's booking confirmation, where its wording is still the stock one.
update automation_steps s
   set config = jsonb_set(
         s.config, '{message}',
         to_jsonb((s.config->>'message') || E'\nأو غيّره بنفسك من هنا: {{appointment.manage_link}}')
       )
  from automations a
 where a.id = s.automation_id
   and a.recipe_key = 'confirm_on_booking'
   and s.step_type = 'send_whatsapp'
   and s.config->>'message' = E'مرحباً {{patient.first_name}} 👋\nتم حجز موعدك في {{clinic.name}}:\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n{{appointment.service}}\n📍 {{clinic.address}}\n\nإذا حاب تغيّر الموعد راسلنا هنا.';
