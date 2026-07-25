-- NULLs must not defeat the one-active-run-per-context guarantee
drop index automation_runs_dedupe;
create unique index automation_runs_dedupe
  on automation_runs (automation_id, patient_id, appointment_id, invoice_id)
  nulls not distinct
  where status in ('running', 'waiting');
