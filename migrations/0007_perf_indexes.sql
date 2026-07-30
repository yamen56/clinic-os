-- Indexes for the counters and queues that run on every page view.
--
-- Each of these backs a query that was doing a heap scan proportional to the
-- clinic's total history, not to the handful of rows it returns. They matter
-- once a clinic has years of data behind it; `npm run bench` is where that
-- shows up.

-- Dashboard and sidebar both sum unread counts for the whole clinic. INCLUDE
-- puts the summed column in the index so it never touches the table.
create index if not exists conversations_unread_idx
  on conversations (clinic_id) include (unread_count);

-- Dashboard "unpaid invoices" counts a small slice of a large table.
create index if not exists invoices_open_idx
  on invoices (clinic_id) where status in ('sent', 'partially_paid');

-- Dashboard "unconfirmed" counts upcoming appointments awaiting action.
create index if not exists appointments_pending_idx
  on appointments (clinic_id, starts_at) where status in ('scheduled', 'pending_approval');

-- The outbound sender claims per clinic, but the existing outbox index leads
-- with status, so every clinic's tick scanned every other clinic's queue.
create index if not exists messages_outbox_clinic_idx
  on messages (clinic_id, scheduled_at) where status = 'queued';
