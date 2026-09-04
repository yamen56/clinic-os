-- Telling somebody when the platform itself is in trouble.
--
-- Every notification path in this product points at a clinic: appointment
-- reminders, daily digests, staff alerts. Nothing pointed at the operator. When
-- the nightly backup stopped running it stopped silently, and five weeks passed
-- with every screen green, because the only report of the failure was a line in
-- a log nobody tails.
--
-- The monitoring page was the first answer and it is not enough: a dashboard
-- that has been green for a month is a dashboard nobody opens. The failure has
-- to come and find you.
--
-- Two tables, and the state is the whole point. Without it every tick that sees
-- a stale backup would send another email, the alerts would be filtered within
-- a day, and the outcome would be exactly the silence this replaces — only
-- noisier. So an alert is *opened* once, *re-notified* on a slow cadence while
-- it persists, and *resolved* explicitly when it clears.

create table if not exists ops_alerts (
  -- A stable identifier for the condition, not for the occurrence:
  -- 'backup_stale', 'worker_jobs_failing', 'whatsapp_down:<clinic id>'.
  -- Reusing the key is what makes a continuing problem one alert rather than
  -- one per minute.
  key            text primary key,
  title          text not null,
  detail         text not null default '',
  opened_at      timestamptz not null default now(),
  last_notified  timestamptz not null default now(),
  -- How many times this open alert has been sent. Rises only on re-notify, so
  -- a high number means "still broken, still ignored" rather than "flapping".
  notifications  int not null default 1
);

-- Small, general bookkeeping for the operator's own machinery — currently the
-- last time the all-clear heartbeat went out.
--
-- The heartbeat exists because of the failure mode this whole file is about: an
-- alerter that has quietly died is indistinguishable from a platform that is
-- perfectly healthy, and both look like an empty inbox. A periodic "nothing is
-- wrong" is what makes silence mean something.
create table if not exists ops_state (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Neither table carries a clinic_id: they are about the platform, not a tenant,
-- so they sit outside RLS in the same way auth_attempts does (0029). The
-- migration runner re-grants on all tables, so no grant is needed here.
