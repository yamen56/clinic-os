------------------------------------------------------------------------------
-- A full arch's implants where they really are, and a bridge's trips to the lab
--
-- A dentist, 2026-11-25. Two things the chart needed room for:
--
--   placed    an implant of a full arch may be moved along the jaw, tilted or
--             deepened after it was recorded — the surgery is rarely exactly
--             the plan. Where it is lives on the entry's own `detail`
--             (src/lib/charts/dental/implant-place.ts); that it was moved, when
--             and by whom is a line in its history.
--
--   lab trips a bridge goes to the lab for its framework, again for the
--             porcelain, again to be finished. That is one order at one price:
--             `stage` is what is being made now, `trips` the ones before it.
--             `units` is how many teeth it was priced for, and `spec` what the
--             lab was told to make, as the chart had it.
--
-- Additive: an order sent before this is one trip, for finished work.
------------------------------------------------------------------------------

alter table chart_mark_events drop constraint if exists chart_mark_events_action_check;
alter table chart_mark_events add constraint chart_mark_events_action_check
  check (action in ('created', 'done', 'void', 'note', 'performer', 'step', 'step_void', 'case', 'reopened', 'fee', 'redone', 'step_edit', 'cost', 'lab', 'date', 'placed'));

alter table lab_cases add column if not exists stage text not null default 'finish';
alter table lab_cases drop constraint if exists lab_cases_stage_check;
alter table lab_cases add constraint lab_cases_stage_check check (stage in ('framework', 'bisque', 'jig', 'teeth', 'finish'));
alter table lab_cases add column if not exists units integer check (units is null or units between 1 and 32);
alter table lab_cases add column if not exists spec jsonb not null default '{}';
alter table lab_cases add column if not exists trips jsonb not null default '[]';
