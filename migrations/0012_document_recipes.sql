-- Backfill the document recipes into clinics that already exist.
--
-- New clinics get them at creation. Without this, "enabled by default" would
-- only be true for clinics created after today, and every existing clinic would
-- silently have no escalation when a consent form goes unsigned.
--
-- Idempotent: `recipe_key` identifies a copy, so re-running changes nothing.
-- Run `npm run seed:recipes` first — that is what puts the templates in place.

do $$
declare
  cl record;
  rt record;
  new_automation uuid;
  step jsonb;
  sort_i integer;
  on_by_default text[] := array[
    'document_expired_alert',
    'document_unsigned_escalate',
    'document_declined_alert'
  ];
begin
  for cl in select id from clinics loop
    for rt in
      select * from recipe_templates
      where key = any(on_by_default) and active
      order by sort
    loop
      if exists (
        select 1 from automations a where a.clinic_id = cl.id and a.recipe_key = rt.key
      ) then
        continue;
      end if;

      insert into automations
        (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key)
      values
        (cl.id, coalesce(nullif(rt.name_ar, ''), rt.name), rt.description,
         rt.trigger_type, rt.trigger_config, true, rt.key)
      returning id into new_automation;

      -- These three recipes are flat step lists; none of them branch, so a
      -- single pass is enough. A recipe with condition children would need the
      -- recursive copy in src/app/admin/actions.ts instead.
      sort_i := 0;
      for step in select * from jsonb_array_elements(rt.steps) loop
        insert into automation_steps
          (clinic_id, automation_id, sort, step_type, config)
        values
          (cl.id, new_automation, sort_i,
           step->>'step_type', coalesce(step->'config', '{}'::jsonb));
        sort_i := sort_i + 1;
      end loop;
    end loop;
  end loop;
end $$;
