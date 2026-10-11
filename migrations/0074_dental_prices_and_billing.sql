-- Prices on the dental chart, and billing from it.
--
-- The dentist asked for each treatment to carry its price — each kind of
-- crown its own — set by the doctor, and for the reception to see what the
-- patient had and bill it. Two decisions shape this migration.
--
-- 1. One price list. The prices are the clinic's Services, which already
--    feed the invoice builder, the booking page and the e-invoice codes. A
--    dental treatment links to a service — "crown, zirconia" to the service
--    that is that crown — rather than a second list beside it, where the same
--    cleaning could cost two different amounts.
--
-- 2. invoice_items is never updated. It is the tax document (0049 says why).
--    Which treatments an invoice line billed lives in a table of its own, and
--    a voided invoice gives its treatments back to "not billed" without a row
--    being touched: a link counts only through an invoice that still stands.

------------------------------------------------------------------------------
-- The price list: a service can be a dental treatment's price
------------------------------------------------------------------------------
alter table services
  add column if not exists chart_key text,
  add column if not exists chart_variant text,
  -- Per treatment, or per session: an orthodontic adjustment is charged each visit.
  add column if not exists price_unit text not null default 'item' check (price_unit in ('item', 'session')),
  -- Made by the dental price list, rather than one of the clinic's own linked to it:
  -- clearing its price retires it, where a linked service is only let go.
  add column if not exists chart_owned boolean not null default false;
create unique index if not exists services_chart_key_idx
  on services (clinic_id, chart_key, coalesce(chart_variant, ''))
  where chart_key is not null;

------------------------------------------------------------------------------
-- A treatment's price, as quoted to this patient
--
-- A snapshot when it is planned, so a change to the price list never
-- rewrites a quote already given. fee_manual: the doctor set it by hand, and
-- a change of material or canals does not re-price it.
------------------------------------------------------------------------------
alter table chart_marks
  add column if not exists fee numeric(12,2) check (fee is null or fee >= 0),
  add column if not exists fee_manual boolean not null default false,
  add column if not exists service_id uuid references services(id) on delete set null;

------------------------------------------------------------------------------
-- Which treatments an invoice line billed
------------------------------------------------------------------------------
create table if not exists invoice_item_marks (
  invoice_item_id uuid not null references invoice_items(id) on delete cascade,
  mark_id uuid not null references chart_marks(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (invoice_item_id, mark_id)
);
create index if not exists invoice_item_marks_mark_idx on invoice_item_marks (mark_id);

alter table invoice_item_marks enable row level security;
drop policy if exists tenant_isolation on invoice_item_marks;
create policy tenant_isolation on invoice_item_marks for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

------------------------------------------------------------------------------
-- From when chart work counts as waiting to be billed
--
-- Everything charted before this release was billed by hand, if at all; it
-- must not reappear on the desk's list as owed. A clinic that starts later
-- starts clean from its own first day.
--
-- The default fills every clinic in place, with no UPDATE: an update would
-- fire clinics_touch and rewrite every clinic's updated_at.
------------------------------------------------------------------------------
alter table clinics add column if not exists dental_billing_since timestamptz not null default now();

------------------------------------------------------------------------------
-- The desk's Ready to bill reads the work finished or stepped on lately, and
-- the rest of each bridge or full arch it belongs to.
------------------------------------------------------------------------------
create index if not exists chart_marks_done_idx on chart_marks (clinic_id, done_at)
  where kind = 'procedure' and voided_at is null and done_at is not null;
create index if not exists chart_marks_group_idx on chart_marks (group_id) where group_id is not null;
create index if not exists chart_mark_steps_done_idx on chart_mark_steps (clinic_id, done_at) where voided_at is null;

------------------------------------------------------------------------------
-- An invoice's change names its patient (emit_patient_change, 0072), so the
-- patient's open file re-reads what is billed when the desk bills or voids,
-- and no other open file does.
------------------------------------------------------------------------------
drop trigger if exists invoices_emit on invoices;
create trigger invoices_emit after insert or update or delete on invoices
  for each row execute function emit_patient_change();

------------------------------------------------------------------------------
-- A price changed on one patient's treatment is a line in its history
------------------------------------------------------------------------------
alter table chart_mark_events drop constraint if exists chart_mark_events_action_check;
alter table chart_mark_events add constraint chart_mark_events_action_check
  check (action in ('created', 'done', 'void', 'note', 'performer', 'step', 'step_void', 'case', 'reopened', 'fee'));
