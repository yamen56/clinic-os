-- Recording things on the day they happened, and hearing about a patient's
-- message the moment it arrives (Yamen, 2026-11-20).
--
-- 1. Chart work can be moved to the day it was really done ("many times I
--    record … and it was not today"). Each move is its own line in the
--    entry's history, like every other change to it: action 'date', with the
--    day it was moved to as the reason.
--
-- Nothing else here needs the schema: an invoice already carries its own
-- `issue_date`, a payment its `paid_at` and an expense its `spent_on`, and the
-- part of a bill paid on the day is an expense with `bill_id` (0099). The new
-- notification kind, `whatsapp_message`, is a value, not a constraint.

alter table chart_mark_events drop constraint if exists chart_mark_events_action_check;
alter table chart_mark_events add constraint chart_mark_events_action_check
  check (action in ('created', 'done', 'void', 'note', 'performer', 'step', 'step_void', 'case', 'reopened', 'fee', 'redone', 'step_edit', 'cost', 'lab', 'date'));
