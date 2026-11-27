------------------------------------------------------------------------------
-- The Doctor plan has no consent forms
--
-- Yamen, 2026-11-28: "the Documents should not be in the doctor plan". It had
-- them signed in the clinic only (0118); now the documents module starts at
-- Clinic+ (src/lib/plans.ts). A clinic already on the Doctor plan loses it
-- here, as choosing the plan today would. Nothing is deleted: its documents
-- come back intact if it moves up a plan.
------------------------------------------------------------------------------

update clinics
   set features = coalesce(features, '{}'::jsonb) || '{"documents": false}'::jsonb
 where plan = 'doctor';
