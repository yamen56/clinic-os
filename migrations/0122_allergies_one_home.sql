------------------------------------------------------------------------------
-- Allergies have one home: the medical history
--
-- 2026-11-28. Clinics (and the old demo seed) kept an "Allergies" /
-- «الحساسية» custom patient field beside the medical history. Its value never
-- reached the medical history card or the prescription's allergy alert, so a
-- file could read "الحساسية: بنسلين" in one card and "no allergies" in the
-- next — the one place a doctor must not be told two things.
--
-- 1. Each patient's value in such a field is added to medical_history
--    .allergies, unless the history already says it (300 characters, the
--    history's own limit).
-- 2. The field comes off the profile form (show_in_profile), so allergies are
--    entered in one place. It stays a merge field for the consent forms that
--    use it, and those now print the medical history's text (lib/esign/fields).
--    Nothing is deleted.
------------------------------------------------------------------------------

with defs as (
  select d.clinic_id, d.storage_key
    from patient_field_definitions d
   where d.scope = 'patient' and not d.is_system and d.storage_key is not null
     and (d.storage_key ~* 'allerg' or d.key ~* 'allerg' or d.label ~* 'allerg' or coalesce(d.label_ar, '') ~ 'حساسي')
),
vals as (
  select p.id, string_agg(distinct trim(p.custom_fields ->> d.storage_key), '، ') as v
    from patients p
    join defs d on d.clinic_id = p.clinic_id
   where coalesce(trim(p.custom_fields ->> d.storage_key), '') <> ''
   group by p.id
)
update patients p
   set medical_history = jsonb_set(
         coalesce(p.medical_history, '{}'::jsonb),
         '{allergies}',
         to_jsonb(left(
           case when coalesce(trim(p.medical_history ->> 'allergies'), '') = '' then vals.v
                else trim(p.medical_history ->> 'allergies') || '، ' || vals.v end,
           300))
       )
  from vals
 where p.id = vals.id
   and position(lower(vals.v) in lower(coalesce(p.medical_history ->> 'allergies', ''))) = 0;

update patient_field_definitions d
   set show_in_profile = false
 where d.scope = 'patient' and not d.is_system and d.storage_key is not null
   and (d.storage_key ~* 'allerg' or d.key ~* 'allerg' or d.label ~* 'allerg' or coalesce(d.label_ar, '') ~ 'حساسي');
