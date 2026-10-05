/*
  What a health-data review asks first: who agreed, and who looked.

  1. The consent a booking link asks for is kept, not just checked: when the
     patient gave it and the words they were shown, copied at that moment. Null
     on every appointment whose link asked nothing, which is most of them.

  2. Opening a patient's file, and pulling a file or a prescription out of it,
     are now written to the audit log (src/lib/audit.ts, auditView) — at most
     once an hour per person and record. That check reads the log by the record
     it is about, which nothing indexed before.
*/
alter table appointments add column if not exists booking_consent jsonb;

create index if not exists audit_log_reads_idx on audit_log (entity_id, action, created_at desc)
  where action in ('patient.view', 'patient.file.view', 'prescription.view');
