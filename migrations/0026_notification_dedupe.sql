-- Stop notifications arriving more than once.
--
-- Three places produced duplicates and none of them looked wrong:
--
--   * doctor reminders matched a 90-second window while the scheduler ticks
--     every 60, so consecutive ticks overlapped by 30 seconds and roughly half
--     of all reminders were sent twice;
--   * the WhatsApp error, blast-guard and disconnection alerts re-fired every
--     time the condition was still true, which for a flapping connection is a
--     notification every few minutes about something the owner already knows;
--   * the daily digests fired on each of the three minutes in their window,
--     fixed separately by claiming a job.
--
-- Rather than a different guard per caller, notifications now carry the same
-- kind of key the jobs table has used all along. A caller that must not repeat
-- passes one; a caller that legitimately repeats — a document signed twice, two
-- separate escalations — passes nothing and behaves exactly as before.

alter table notifications add column if not exists dedupe_key text;

-- Partial, so the vast majority of notifications (which have no key) are
-- unaffected and cost nothing to insert.
create unique index if not exists notifications_dedupe_idx
  on notifications (dedupe_key) where dedupe_key is not null;
