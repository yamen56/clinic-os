-- Who added a patient, and a chart that tells the other screens it changed.
--
-- 1. A patient typed in at the clinic said only "الموظفون" — somebody on the
--    staff. The desk asked who: the doctor or the receptionist, and by name.
--    The audit log has known for every file typed in since it existed, and an
--    import batch knows who ran it, so the column starts filled for those;
--    every path that creates a patient fills it from now on. A patient who
--    came in by WhatsApp, the booking link or the AI receptionist has no
--    person behind them, and the source still says which.
--
-- 2. chart_marks announces its changes the way appointments and invoices do,
--    so a second screen on the same patient — the assistant's tablet beside
--    the dentist's — redraws without a reload, and the file re-reads the chart
--    whenever it may be holding an old copy.

alter table patients add column if not exists created_by uuid references users(id) on delete set null;

comment on column patients.created_by is
  'The person who typed this patient in, or who ran the import that brought
   them. Null for patients who arrived by WhatsApp, the booking link or the AI
   receptionist, and for any whose creation predates the audit log.';

-- The backfill holds the table's own triggers, as 0069 did: it would otherwise
-- stamp every patient's updated_at and send a realtime event per row to every
-- open workspace.
alter table patients disable trigger patients_touch;
alter table patients disable trigger patients_emit;

update patients p
   set created_by = a.user_id
  from (select distinct on (entity_id) entity_id, user_id
          from audit_log
         where action = 'patient.create' and entity = 'patient' and user_id is not null
         order by entity_id, created_at) a
 where p.created_by is null
   and a.entity_id = p.id::text;

update patients p
   set created_by = b.created_by
  from import_batches b
 where p.created_by is null
   and p.import_batch_id = b.id
   and b.created_by is not null;

alter table patients enable trigger patients_touch;
alter table patients enable trigger patients_emit;

-- The patient travels with the event, so an open file re-reads its chart for
-- its own patient's changes only — not every time anyone in the clinic charts
-- a tooth on somebody else.
create or replace function emit_patient_change() returns trigger language plpgsql as $$
declare rec record;
begin
  rec := coalesce(new, old);
  perform pg_notify('app_events', json_build_object(
    't', tg_table_name,
    'op', lower(tg_op),
    'id', rec.id,
    'clinic_id', rec.clinic_id,
    'patient_id', rec.patient_id
  )::text);
  return null;
end $$;

drop trigger if exists chart_marks_emit on chart_marks;
create trigger chart_marks_emit after insert or update or delete on chart_marks
  for each row execute function emit_patient_change();
