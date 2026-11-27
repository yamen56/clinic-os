------------------------------------------------------------------------------
-- Three plans, and the number of people a plan lets a clinic have
--
-- Yamen, 2026-11-27. `clinics.plan` was a free-text label nothing read; it is
-- now one of three, and choosing one writes its modules into `features`
-- (src/lib/plans.ts). This file does three things:
--
--   plan       doctor | clinic_plus | clinic_pro. Every clinic already on the
--              platform becomes clinic_plus, or clinic_pro where its AI
--              receptionist is switched on — so nothing any of them uses today
--              is taken away. The agency moves them from the admin afterwards.
--
--   features   the new plan modules written out for those clinics. Four of
--              them (esign_remote, booking, devices, automations_advanced)
--              would read as on anyway; branches and branding are opt-in, so
--              silence would be off. `ai` goes off for clinic_plus, because
--              that plan does not include it and none of them run it.
--
--   seats      `member_limit`: active members including the owner and anyone
--              invited; null is no limit. Enforced by the staff screen and, as
--              a backstop that a race or a forgotten path cannot get round, by
--              the trigger below.
--
-- Also the billing dates the admin's overview reads (trial_ends_at,
-- paid_until) and a private note for the agency.
------------------------------------------------------------------------------

update clinics cl
   set plan = case
                when exists (select 1 from ai_agents a where a.clinic_id = cl.id and a.enabled) then 'clinic_pro'
                else 'clinic_plus'
              end
 where plan not in ('doctor', 'clinic_plus', 'clinic_pro');

alter table clinics alter column plan set default 'clinic_plus';
alter table clinics drop constraint if exists clinics_plan_check;
alter table clinics add constraint clinics_plan_check check (plan in ('doctor', 'clinic_plus', 'clinic_pro'));

update clinics
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object(
         'esign_remote', coalesce((features->>'esign_remote')::boolean, true),
         'booking', coalesce((features->>'booking')::boolean, true),
         'devices', coalesce((features->>'devices')::boolean, true),
         'automations_advanced', coalesce((features->>'automations_advanced')::boolean, true),
         'branches', plan <> 'doctor',
         'branding', plan = 'clinic_pro',
         'ai', case when plan = 'clinic_pro' then coalesce((features->>'ai')::boolean, true) else false end
       );

alter table clinics add column if not exists member_limit integer;
alter table clinics drop constraint if exists clinics_member_limit_check;
alter table clinics add constraint clinics_member_limit_check check (member_limit is null or member_limit >= 1);
update clinics set member_limit = 2 where plan = 'doctor' and member_limit is null;

alter table clinics add column if not exists trial_ends_at timestamptz;
alter table clinics add column if not exists paid_until date;
alter table clinics add column if not exists admin_notes text not null default '';

/*
  A clinic at its limit cannot gain an active member: not by an invitation,
  not by re-activating someone who left. Counted under a per-clinic advisory
  lock, so two invitations sent at the same moment cannot both squeeze into
  the last seat. Definer, because the count must see every member of the
  clinic whoever is inviting.
*/
create or replace function enforce_member_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_limit integer; v_count integer;
begin
  if not new.active then return new; end if;
  if tg_op = 'UPDATE' and old.active then return new; end if;
  select member_limit into v_limit from clinics where id = new.clinic_id;
  if v_limit is null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('member_limit:' || new.clinic_id::text));
  select count(*) into v_count from clinic_members
   where clinic_id = new.clinic_id and active and id <> new.id;
  if v_count >= v_limit then
    raise exception 'member_limit' using errcode = 'P0001', detail = format('limit %s', v_limit);
  end if;
  return new;
end $$;

drop trigger if exists clinic_members_limit on clinic_members;
create trigger clinic_members_limit before insert or update of active on clinic_members
  for each row execute function enforce_member_limit();
