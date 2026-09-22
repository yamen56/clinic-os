-- Where an application error goes, so somebody other than the customer finds it.
--
-- Every alarm in this system watches infrastructure: the backup engine, stuck
-- jobs, failed sends, whether the worker is still breathing, whether the web
-- app answers `/api/health`. None of them watches the *application*. A server
-- action that throws for one clinic on one screen returns a 500 to that
-- receptionist, prints one line into Railway's log with no clinic id, no user,
-- no request and no stack worth grouping, and is then gone. `/api/health` goes
-- on answering 200 the whole time, because the database is up and that is all
-- it was ever asked.
--
-- So the first anyone hears of it is a clinic sending a WhatsApp message. That
-- is the gap this closes.
--
-- **Grouped, not logged.** One row per distinct fault rather than per
-- occurrence: an error that fires four thousand times in an afternoon is one
-- thing to fix, and storing it four thousand times turns the record of a bad
-- day into a second bad day. The fingerprint carries the grouping and `count`
-- carries the volume, which is also what makes "is this getting worse?"
-- answerable from one row.

create table if not exists app_errors (
  -- sha256 of the normalised message, the first stack frame and the route.
  -- Normalised because ids vary and the fault does not: "patient <uuid> not
  -- found" is one bug, not one bug per patient.
  fingerprint text primary key,
  message text not null,
  stack text,
  -- The route pattern where it surfaced ('/c/[slug]/invoices'), never the
  -- filled-in path: a fingerprint per clinic slug would defeat the grouping.
  route text,
  -- 'server' | 'action' | 'route-handler' | 'client' — where in the request it
  -- came from, because the three have different fixes.
  kind text,
  count int not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  /*
    Deliberately not foreign keys. This table has to be writable at the moment
    something is going wrong, and a fault that happens *because* a clinic row is
    missing must still be recordable — an error log that can itself fail on a
    constraint is an error log that goes quiet exactly when it matters.
  */
  last_clinic_id uuid,
  last_user_id uuid,
  -- Next's own error digest, so a stack-free production client report can still
  -- be tied back to the server error that produced it.
  last_digest text,
  -- Cleared by hand from /admin/monitoring once somebody has dealt with it.
  -- Resolved rows stay for the history and stop counting toward the alert.
  resolved_at timestamptz
);

-- The monitoring page reads "what is open, worst first"; the alert reads "what
-- is new since last time". Both lead with last_seen among unresolved rows.
create index if not exists app_errors_open_idx
  on app_errors (last_seen desc) where resolved_at is null;

-- Pruning reads by age alone and would otherwise scan the table.
create index if not exists app_errors_age on app_errors (last_seen);

-- Same shape as auth_attempts (0032), the ops tables (0043) and rate_counters
-- (0056). No tenant in here to isolate — `last_clinic_id` is a breadcrumb, not
-- ownership — but a table with no policy is a table the app role can empty, and
-- what this one holds is the knowledge that something is broken. Every caller
-- goes through `withSystem`, so admin-only costs nothing.
alter table app_errors enable row level security;
drop policy if exists app_errors_access on app_errors;
create policy app_errors_access on app_errors for all to clinicos_app
  using (app_is_admin())
  with check (app_is_admin());
