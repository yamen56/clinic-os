------------------------------------------------------------------------------
-- Vital signs on the visit record
--
-- 2026-11-28. The visit record (0108) held what was said and found as text:
-- complaint, examination, diagnosis, plan. A blood pressure or a weight
-- typed into "examination" cannot be compared with the last visit's, and a
-- doctor following a hypertensive or diabetic patient needs exactly that.
--
-- `vitals` holds the numbers by name — bp_sys, bp_dia (mmHg), pulse (/min),
-- temp (°C), spo2 (%), weight (kg), height (cm), sugar (mg/dL). A key is
-- absent until it is measured; clearing a field removes it. BMI is worked out
-- from weight and height when shown, never stored. Ranges are checked by the
-- app (lib/treatment/vitals); here only the shape.
------------------------------------------------------------------------------

alter table visit_records
  add column if not exists vitals jsonb not null default '{}'::jsonb;
alter table visit_records drop constraint if exists visit_records_vitals_object;
alter table visit_records
  add constraint visit_records_vitals_object check (jsonb_typeof(vitals) = 'object');

-- What the record said before a change, the numbers included.
alter table visit_record_versions
  add column if not exists vitals jsonb not null default '{}'::jsonb;
