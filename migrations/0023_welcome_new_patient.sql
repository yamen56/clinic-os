-- A welcome message when a patient file is created.
--
-- The trigger has existed since 0001 and the builder has always offered it, but
-- nothing emitted it from the patients page and no clinic had an automation
-- listening — so adding a patient sent nothing. The emit is fixed in
-- createPatientAction; this gives it something to reach.
--
-- Switched on, because a clinic that adds a patient expects the patient to hear
-- from them; it is one toggle in Automations to turn off.
--
-- The template is inserted here rather than assumed, and that is the whole point
-- of the shape of this file. 0012 reads `recipe_templates` and depends on
-- `seed:recipes` having run first; when this migration was written that way it
-- ran against a database seeded afterwards, found nothing, created nothing for
-- sixty-four clinics, and was still recorded as applied — a silent no-op with no
-- way to notice and no way to re-run. A migration must not depend on the order
-- of a separate command. `seed:recipes` upserts this same key with the same
-- content, so seeding after this still converges.

insert into recipe_templates (key, name, name_ar, description, trigger_type, trigger_config, steps, sort)
values (
  'welcome_new_patient',
  'Welcome a new patient',
  'ترحيب بمريض جديد',
  'Greets a patient on WhatsApp as soon as their file is created.',
  'patient_created',
  '{}'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'step_type', 'send_whatsapp',
      'config', jsonb_build_object(
        'message',
        'مرحباً {{patient.first_name}} 👋' || chr(10) ||
        'أهلاً بك في {{clinic.name}}.' || chr(10) ||
        'سجّلنا ملفك عندنا، وهذا رقمنا على واتساب لأي استفسار أو حجز موعد.' || chr(10) || chr(10) ||
        'كيف يمكننا مساعدتك؟'
      )
    )
  ),
  0
)
on conflict (key) do nothing;

do $$
declare
  cl record;
  rt record;
  new_automation uuid;
  step jsonb;
  sort_i integer;
begin
  select * into rt from recipe_templates where key = 'welcome_new_patient';

  for cl in select id from clinics loop
    -- Idempotent by recipe_key, like 0012: a clinic that already has a copy
    -- (including one the clinic has since edited) is left alone.
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

    -- A flat step list, so one pass is enough; see the note in 0012 about
    -- recipes that branch.
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
end $$;
