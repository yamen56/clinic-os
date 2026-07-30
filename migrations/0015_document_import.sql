-- Two things a clinic that already runs on paper needs.
--
-- 1. A finished PDF that was signed somewhere else. Documents get printed,
--    signed at a desk, scanned. Until now that copy had nowhere to live, so the
--    record in here said "sent" forever while the signed paper sat in a drawer.
--    `final_pdf_source` records how the file on `final_pdf_path` came to be, so
--    the screen can be honest about which one it is showing — a PDF this
--    platform composed from signatures it captured, or a file somebody handed
--    it. They carry very different evidentiary weight and must not look alike.
--
-- 2. The audit trail needs a word for it. `document_events` is append-only and
--    its type list is a check constraint, so a new kind of event is a schema
--    change by design — you cannot quietly start logging something new.

alter table documents
  add column if not exists final_pdf_source text not null default 'generated'
    check (final_pdf_source in ('generated', 'uploaded'));

alter table document_events drop constraint if exists document_events_event_type_check;

alter table document_events add constraint document_events_event_type_check check (
  event_type in (
    'created', 'sent', 'link_opened', 'otp_sent', 'otp_verified', 'viewed',
    'field_completed', 'signed', 'declined', 'reminder_sent', 'completed',
    'downloaded', 'voided', 'expired', 'revoked', 'resent', 'hash_mismatch',
    'locked', 'unlocked', 'superseded',
    -- A signed copy was uploaded rather than captured here.
    'final_uploaded',
    -- A template was created from a file the clinic already had.
    'imported'
  )
);
