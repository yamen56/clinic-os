------------------------------------------------------------------------------
-- What a treatment costs the clinic, and how that comes into a doctor's share
--
-- Yamen, 2026-10-17: "we want the system to understand the cost of the
-- materials so it can calculate them ... the main thing i need to have is the
-- costs in the treatments that it calculate it between the doctors". A crown
-- that bills 300 has cost the clinic its lab work and its materials, and a
-- doctor paid a percentage of the 300 is paid on money that was never the
-- clinic's to share.
--
-- Two costs, each with the treatment it belongs to:
--
--   materials  one cost per price on the list (services.material_cost). A
--              patient's treatment costs what its price's service says,
--              unless one was set for that patient by hand
--              (chart_marks.material_cost; null means the list's). It can be
--              changed until the work is billed, and at billing it is frozen
--              with the doctor's rate. Unlike a price, a cost is never quoted
--              to anybody, so the list's cost is not snapshotted: a treatment
--              not billed yet costs what the list says today.
--   lab work   0082: a lab case on the treatment, at the lab's own price.
--
-- How a doctor shares them is the clinic's deal with that doctor, chosen for
-- each one (Yamen chose "per doctor"):
--
--   shared     the costs come off the price, and the doctor's percentage is
--              of what is left: doctor and clinic carry them in proportion.
--   doctor     the doctor's percentage is of the price, and the costs come
--              off the doctor's share.
--
-- The rule is frozen on the line with the rate (0049's reasoning): changing a
-- doctor's deal in March must not rewrite January.
--
-- Clinic expenses still attach to nobody (0050). Material bought in bulk and
-- the lab's monthly bill are money the clinic spent. A treatment's own costs
-- are what that one piece of work used, and only those come into its doctor's
-- share.
------------------------------------------------------------------------------

alter table services
  add column if not exists material_cost numeric(12,2) check (material_cost is null or material_cost >= 0);
comment on column services.material_cost is
  'What the materials for this service cost the clinic, each. Null: not set,
   which costs nothing. Copied onto a dental treatment with its price.';

-- This patient's materials, set by hand. Null: the list's, through service_id.
alter table chart_marks
  add column if not exists material_cost numeric(12,2) check (material_cost is null or material_cost >= 0);

------------------------------------------------------------------------------
-- The deal
--
-- Like commission_percent, RLS does not protect this column: members_access
-- admits every member to every clinic_members row. Only the owner's staff
-- query and a doctor's own earnings page select it.
------------------------------------------------------------------------------
alter table clinic_members
  add column if not exists costs_rule text not null default 'shared' check (costs_rule in ('shared', 'doctor'));
comment on column clinic_members.costs_rule is
  'How this doctor shares a treatment''s costs (materials, lab): shared = off the
   price before the percentage; doctor = off the doctor''s share. Not protected
   by RLS -- see 0049.';

alter table invoice_line_doctors
  add column if not exists costs_rule text not null default 'shared' check (costs_rule in ('shared', 'doctor')),
  add column if not exists material_cost numeric(12,2) not null default 0 check (material_cost >= 0);
comment on column invoice_line_doctors.material_cost is
  'The materials the billed work used, frozen at billing: the treatment''s cost
   times the line''s quantity. Lab work is read live from lab_cases (0082).';

------------------------------------------------------------------------------
-- A treatment's history says when its costs changed
--
-- 'cost': this patient's material cost set by hand, or back to the list's.
-- 'lab':  a lab case sent, received, cancelled, or re-costed (0082).
------------------------------------------------------------------------------
alter table chart_mark_events drop constraint if exists chart_mark_events_action_check;
alter table chart_mark_events add constraint chart_mark_events_action_check
  check (action in ('created', 'done', 'void', 'note', 'performer', 'step', 'step_void', 'case', 'reopened', 'fee', 'redone', 'step_edit', 'cost', 'lab'));
