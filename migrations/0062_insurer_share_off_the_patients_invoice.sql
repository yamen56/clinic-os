/*
  The insurer's share is not the patient's sale.

  An insured invoice used to be filed with JoFotara for its full total, the
  patient as buyer. The insurer's share of it is invoiced to the insurer — by
  Hakeem Claim, which issues the tax invoice itself when a claim is submitted
  through it, or by the clinic directly — so the same money reached the tax
  authority twice. From here the patient's document carries only what the
  patient owes (src/lib/einvoice/share.ts).

  `einvoice_excluded` is what a filing actually left off, written by the worker
  when ISTD accepts the document. A fact about a past submission, not a setting:
  a credit note mirrors the document that was filed, so it splits by this
  number rather than by whatever `insurer_amount` says later. Null on every
  invoice filed before today, which is the truth — nothing was left off them.
*/
alter table invoices add column if not exists einvoice_excluded numeric(12,2)
  check (einvoice_excluded is null or einvoice_excluded >= 0);

/*
  'skipped': the insurer covers the whole invoice, so there is no sale to the
  patient to report. Recorded in the trail rather than silently dropped, so a
  clinic asked "why is there no QR on this one" can read the answer.
*/
alter table invoice_einvoice_events drop constraint if exists invoice_einvoice_events_kind_check;
alter table invoice_einvoice_events add constraint invoice_einvoice_events_kind_check
  check (kind in ('queued', 'submitted', 'accepted', 'rejected', 'error', 'skipped'));
