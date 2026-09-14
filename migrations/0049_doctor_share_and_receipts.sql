------------------------------------------------------------------------------
-- What the clinic owes the doctor, and what the patient gets back
--
-- Three things that arrived together, and share one migration because they
-- share one screen: the money side of a visit.
--
-- 1. A doctor's share. Clinics here pay a doctor a percentage of what they
--    bring in, and nothing in this schema could say so. The only path from
--    revenue to a doctor was invoices.appointment_id -> appointments
--    .doctor_member_id, which is nullable and says nothing about a rate. So the
--    split lived on paper and the doctor took the clinic's word for it.
--
-- 2. A receipt. An invoice is a demand and a receipt is an acknowledgement.
--    Until now a settled invoice was re-sent worded as a receipt, which is the
--    same document restamped -- fine as far as it went, and not what a patient
--    hands an employer.
--
-- 3. The updated_at trigger 0047 should have attached to service_sections.
--
-- Everything is additive and nullable. A clinic that sets no rate and issues no
-- receipt sees exactly the product it saw yesterday -- the standard 0047 set
-- for itself, and the reason there is no backfill here either.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- The arrangement
--
-- Null is not zero. Null means there is no arrangement with this member; zero
-- means there is one and it is worth nothing. A clinic needs to be able to say
-- either, and the difference decides whether the doctor sees an earnings screen
-- at all.
--
-- Note for anyone reading this later: RLS does NOT protect this column.
-- `members_access` admits any member of the clinic to every clinic_members row,
-- so a receptionist's session can read every doctor's rate as far as the
-- database is concerned. Confidentiality is application-layer: only the staff
-- settings query (gated on settings.staff) and a doctor's own earnings page may
-- select it. Every other member list selects id and name.
------------------------------------------------------------------------------
alter table clinic_members
  add column if not exists commission_percent numeric(5,2)
    check (commission_percent >= 0 and commission_percent <= 100);

comment on column clinic_members.commission_percent is
  'Percentage of the ex-tax net this doctor earns on work billed to them. Null
   means no revenue-sharing arrangement, which is not the same as zero. Not
   protected by RLS -- see the migration note.';

------------------------------------------------------------------------------
-- Whose work a line was
--
-- A table of its own rather than two columns on invoice_items, and the reason
-- is worth the join it costs.
--
-- invoice_items IS the tax document: worker/einvoice.ts builds the UBL straight
-- off it, and the immutability rule this product relies on -- nothing touches a
-- raised invoice except its title -- is what makes that safe. Attribution has
-- to stay correctable, because who performed the work is known at the desk and
-- not always at the moment of billing. Putting a mutable column on invoice_items
-- would make "UPDATE invoice_items after issue" a thing that exists here, and
-- the next person fixing a typo in a description would find it already done.
--
-- Kept apart, invoice_items stays byte-for-byte what was billed, the credit-note
-- line copy in voidInvoiceAction needs no change and cannot regress by dropping
-- a column from its explicit select, and "never UPDATE invoice_items" stays an
-- invariant a test can assert.
--
-- commission_percent is frozen here at billing rather than joined from the
-- member, for the reason booking answers are frozen onto the appointment:
-- raising a doctor's rate in March must not silently rewrite January's payouts.
--
-- on delete cascade for the member, not set null: a row with no doctor would be
-- a rate owed to nobody. Deactivating a member is the ordinary case and leaves
-- the row alone; deleting one outright is rare and means the arrangement is
-- gone. The invoice, its lines and its money are untouched either way.
------------------------------------------------------------------------------
create table if not exists invoice_line_doctors (
  invoice_item_id    uuid primary key references invoice_items(id) on delete cascade,
  clinic_id          uuid not null references clinics(id) on delete cascade,
  doctor_member_id   uuid not null references clinic_members(id) on delete cascade,
  commission_percent numeric(5,2) not null
    check (commission_percent >= 0 and commission_percent <= 100),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Serves the doctor's own earnings page and the owner's payout report, which
-- are both "this clinic, this doctor, over a period".
create index if not exists invoice_line_doctors_doctor_idx
  on invoice_line_doctors (clinic_id, doctor_member_id);

comment on table invoice_line_doctors is
  'Which doctor earned an invoice line, and the rate as it stood when the work
   was billed. Kept off invoice_items so that table stays immutable after issue.';

------------------------------------------------------------------------------
-- A receipt
--
-- One per invoice, and only once it is settled in full. It lives as columns on
-- the invoice rather than as a table of its own because it is one-per-invoice
-- and a fully-paid invoice does not change underneath it.
--
-- Its own number series, not the invoice's. Reusing the invoice number would
-- put the clinic's sequence -- and, through it, the tax authority's numbering --
-- in the path of a courtesy document. A receipt is filed with nobody.
--
-- receipt_token is separate from public_token so the two documents are
-- addressed independently, even though a patient holding one may see the other.
------------------------------------------------------------------------------
alter table clinics
  add column if not exists receipt_prefix  text    not null default 'RCP',
  add column if not exists receipt_counter integer not null default 0;

alter table invoices
  add column if not exists receipt_seq       integer,
  add column if not exists receipt_number    text,
  add column if not exists receipt_token     text unique,
  add column if not exists receipt_pdf_path  text,
  add column if not exists receipt_issued_at timestamptz,
  add column if not exists receipt_sent_at   timestamptz;

comment on column invoices.receipt_number is
  'Allocated lazily, the first time a receipt is issued for this invoice. Null
   until then, which is every invoice that has not been settled and receipted.';

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['invoice_line_doctors'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

------------------------------------------------------------------------------
-- updated_at
--
-- service_sections is 0047's: the attach loop in 0001 runs over the tables that
-- existed when it ran, and nothing re-ran it after 0047, so that table's
-- updated_at has been frozen at insert ever since.
------------------------------------------------------------------------------
drop trigger if exists invoice_line_doctors_touch on invoice_line_doctors;
create trigger invoice_line_doctors_touch before update on invoice_line_doctors
  for each row execute function touch_updated_at();

drop trigger if exists service_sections_touch on service_sections;
create trigger service_sections_touch before update on service_sections
  for each row execute function touch_updated_at();
