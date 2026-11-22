-- Due back: reception can take a patient off the list (2026-11-22).
--
-- The list (lib/due-back) is every patient whose doctor asked for another
-- visit that nobody has booked. Until now a patient stayed on it for ever if
-- they said "not now", moved away, or went elsewhere — nothing took them off
-- but a booking — so the list grew into names nobody would call. The hand-off
-- itself (`next_visit_days`) stays as the doctor wrote it; this only records
-- that the desk dealt with it, by whom and when, and Undo clears it.
alter table appointments add column if not exists next_visit_dismissed_at timestamptz;
alter table appointments add column if not exists next_visit_dismissed_by uuid references users(id) on delete set null;
