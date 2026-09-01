-- Three choices that were previously made once, for everybody, and are now made
-- one at a time: what an invoice is called, whether it goes to the tax
-- authority, and whether a patient hears from the automations at all.

------------------------------------------------------------------------------
-- 1. An invoice's own name
------------------------------------------------------------------------------
/*
  Optional, and empty by default — which is the whole requirement. An invoice is
  identified by its number and always will be; the title is what the clinic
  calls the work, for the desk and for the patient reading the PDF a month
  later ("Root canal, upper left", "Implant — stage 2 of 3").

  Not `null`able: every other free-text column on this table is `not null
  default ''`, and one nullable one would mean every read site had to decide
  what an absent title is. It is the empty string, and the empty string renders
  as nothing.

  Deliberately not carried into the UBL document. ISTD validates a fixed shape
  and a title is not part of it; a field the clinic types freely must not be
  able to fail a tax submission.
*/
alter table invoices add column if not exists title text not null default '';

------------------------------------------------------------------------------
-- 2. Whether this invoice is filed with JoFotara
------------------------------------------------------------------------------
/*
  Filing used to follow from the clinic's switch alone: enabled meant every
  invoice, reported on payment, on delivery, or by the nightly sweep. That is
  right for a clinic whose whole practice is inside the e-invoicing net, and
  wrong for one raising an internal receipt, a staff discount, or a sale it
  accounts for elsewhere.

  `true` by default, so nothing that files today stops filing. The clinic-level
  default below is what a practice flips when it wants to choose case by case;
  this column is the case-by-case answer.

  Note this is *permission to file*, not a state — `einvoice_status` remains the
  state. An invoice with `file_einvoice = false` simply never leaves
  'not_required', and turning the flag back on later is what queues it.
*/
alter table invoices add column if not exists file_einvoice boolean not null default true;

-- The sweep's worklist is "issued, unfiled and meant to be filed", so the flag
-- belongs in the index rather than as a filter over everything it returns.
drop index if exists invoices_einvoice_unfiled_idx;
create index if not exists invoices_einvoice_unfiled_idx
  on invoices (clinic_id, created_at)
  where einvoice_status = 'not_required' and file_einvoice;

/*
  The clinic's answer for invoices nobody has said anything about.

  A practice that files everything leaves this on and never sees the per-invoice
  switch matter. A practice that files selectively turns it off once, and every
  new invoice then starts unfiled until somebody says otherwise.
*/
alter table clinic_einvoice_settings
  add column if not exists file_by_default boolean not null default true;

------------------------------------------------------------------------------
-- 3. A patient who does not want to be messaged by the machine
------------------------------------------------------------------------------
/*
  One switch on the file, covering every automation and every campaign: the
  reminders, the recalls, the birthday note, the bulk send. Asked for by real
  people often enough — the patient who says "stop texting me" — and the only
  alternative today is deleting or archiving the file, which throws away the
  clinical record to silence a reminder.

  What it does NOT stop, deliberately:
    - a message a colleague types and sends themselves;
    - the confirmation for a booking the patient just made;
    - an invoice or a document a member of staff pressed Send on.
  All three are a person deciding to contact somebody who is mid-conversation
  with the clinic. Muting the automations is not the same as refusing contact,
  and a clinic that cannot answer its own patient has been given a worse product
  rather than a more respectful one.

  Enforced at `startRun` — one place, covering every trigger, the scheduler's
  three time-based ones, and one automation handing off to another — plus the
  campaign audience and the campaign pump, because a recipient list is frozen
  when the campaign is built and a patient may opt out after that.
*/
alter table patients add column if not exists automation_opt_out boolean not null default false;

-- Small and partial: the automations screen counts these, and the patient list
-- filters to them. Both questions are "who is muted", never "who is not".
create index if not exists patients_opt_out_idx on patients (clinic_id)
  where automation_opt_out;
