-- The dental chart tells the automations when a treatment is finished.
--
-- Yamen, 2026-11-03: "if you saw that we have to use some automation that is
-- needed for certain treatment, let's work on it". Aftercare after an
-- extraction was a recipe started by a tag reception had to remember to add;
-- the chart already knows the moment the extraction is done.
--
-- A trigger on chart_marks rather than a call from each route, because a
-- treatment is finished in five places — marked done, "Finish now", its last
-- step, a bridge's teeth with their lead, recorded as done — and the next one
-- written would be the one that forgot. Only dental procedures, only into
-- 'done' (work recorded as already there is 'existing' and says nothing).
--
-- The event waits 150 seconds: a treatment recorded by mistake is taken back
-- within the chart's two-minute undo, and the worker looks again before it
-- acts. One event per patient, treatment and day: three teeth out at one
-- visit are one set of aftercare, not three.

create or replace function chart_mark_done_event() returns trigger language plpgsql as $$
begin
  if new.chart = 'dental' and new.kind = 'procedure' and new.status = 'done' and new.voided_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    insert into jobs (clinic_id, kind, payload, dedupe_key, run_at)
    values (
      new.clinic_id,
      'trigger:treatment_done',
      jsonb_build_object('patientId', new.patient_id, 'markId', new.id, 'treatmentKey', new.treatment_key),
      'treatment_done:' || new.patient_id || ':' || new.treatment_key || ':' || to_char(now(), 'YYYY-MM-DD'),
      now() + interval '150 seconds'
    )
    on conflict (dedupe_key) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists chart_marks_done_event on chart_marks;
create trigger chart_marks_done_event after insert or update of status on chart_marks
  for each row execute function chart_mark_done_event();
