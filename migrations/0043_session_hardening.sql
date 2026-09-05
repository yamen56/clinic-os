-- Two limits on a session that previously had only one.
--
-- A session lasted thirty days from the moment it was created, was never
-- rotated, and had no idea whether it had been used in the meantime. For a
-- workspace holding medical records that means a laptop left in a taxi is a
-- month of access to patient files, and nothing about the account's behaviour
-- shortens it.
--
-- `last_seen_at` adds the second limit: a session unused for the idle window
-- stops working even though its thirty days have not run out. The absolute
-- expiry still caps total exposure; this caps *unattended* exposure, which is
-- the shape almost every real credential theft takes.
--
-- `reauth_at` is for the handful of actions where being signed in is not a
-- strong enough claim — exporting every patient record in the clinic, or
-- destroying a tenant. Those ask for the password again, and this records when
-- it was last given.

alter table sessions
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists reauth_at    timestamptz;

/*
  Existing sessions start their idle window now rather than at creation.

  Backfilling from created_at would be more literal and would sign out every
  active user the moment this deploys — a self-inflicted outage during working
  hours, to enforce a policy retroactively against people who have done nothing
  wrong. The policy applies from here.
*/
update sessions set last_seen_at = now() where last_seen_at is null;

/*
  Sessions are looked up by token_hash, which is already unique, so the idle
  check costs nothing extra on the hot path. This index is for the sweep that
  deletes dead rows, which reads by age alone and would otherwise scan.
*/
create index if not exists sessions_last_seen_idx on sessions (last_seen_at);
