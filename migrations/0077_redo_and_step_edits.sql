-- A treatment done again, and a step put right.
--
-- A dentist, 2026-10-15: a patient comes back with a problem in work done
-- before — the crown has to be made again, the root canal re-treated — and a
-- crown may be replaced two or three times. The redo is a treatment of its
-- own (its own steps, its own price, its own invoice line), pointing at the
-- work it redoes so the tooth reads "crown, then its redo, then another".
-- The old work stays exactly as it was: it was done.
alter table chart_marks add column if not exists redo_of uuid references chart_marks(id) on delete set null;
create index if not exists chart_marks_redo_idx on chart_marks (redo_of) where redo_of is not null;

-- 'redone': the line on the old work saying a redo was started on it.
-- 'step_edit': a recorded step's data corrected — the files used, the crown type.
alter table chart_mark_events drop constraint if exists chart_mark_events_action_check;
alter table chart_mark_events add constraint chart_mark_events_action_check
  check (action in ('created', 'done', 'void', 'note', 'performer', 'step', 'step_void', 'case', 'reopened', 'fee', 'redone', 'step_edit'));
