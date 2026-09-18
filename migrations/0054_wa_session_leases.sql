------------------------------------------------------------------------------
-- Who owns a clinic's WhatsApp socket
--
-- The worker holds one live Baileys socket per clinic, in one process, and
-- that is the first ceiling the platform hits -- somewhere around 60-100
-- clinics, never measured. Every other loop in the worker is already safe to
-- run in several processes at once: jobs, outbound and campaigns all claim
-- with `for update skip locked`, and the scheduler writes through
-- `on conflict (dedupe_key) do nothing`. The sockets are the only reason a
-- second worker could not simply be started.
--
-- They are the reason because `resumeDesiredSessions` claimed *every* clinic
-- marked desired. Two workers would each connect every number, WhatsApp would
-- answer the second with `connectionReplaced`, and the two would take turns
-- knocking each other off -- the same collision the SIGTERM handling exists to
-- avoid on deploys, except permanent.
--
-- A lease fixes that: a clinic's socket belongs to exactly one worker at a
-- time, and the claim is the same mechanism the jobs table has run on in
-- production for months. Capacity then reads `workers x sessions per worker`,
-- and a worker that dies has its clinics picked up by the others within the
-- lease window rather than staying dark until someone notices.
--
-- Deliberately a table of its own rather than two columns on
-- whatsapp_sessions, and the reason is the heartbeat. A lease is renewed every
-- few seconds forever. whatsapp_sessions carries the `updated_at` touch
-- trigger and `emit_wa_change`, which fires `pg_notify` on every write -- so
-- renewing in place would push a realtime event to every open tab in the
-- clinic several times a minute, for nothing. This table has neither trigger,
-- so a heartbeat costs one row write and wakes nobody.
------------------------------------------------------------------------------
create table if not exists wa_session_leases (
  -- One lease per clinic, enforced by the primary key: the uniqueness *is* the
  -- mutual exclusion, so two workers cannot both believe they own a socket
  -- even if they ask in the same millisecond.
  clinic_id uuid primary key references clinics(id) on delete cascade,
  -- Which process holds it. Free text rather than a foreign key -- a worker is
  -- not a row in this database, it is a container that may never come back.
  owner_id text not null,
  heartbeat_at timestamptz not null default now(),
  -- Whether the owner actually has a live socket for this clinic right now, as
  -- opposed to merely being responsible for having one.
  --
  -- Admin monitoring has always compared two answers to "is this clinic
  -- connected": the status column, which the session writes, and whether the
  -- worker really holds the socket -- the disagreement between them is how a
  -- wedged session gets noticed. That second answer used to come from the
  -- process answering `/health`, which stops being true the moment there is
  -- more than one worker: every clinic owned by a different replica would read
  -- as absent rather than as live. Published here so the question can be
  -- answered about all of them at once.
  connected boolean not null default false
);

-- The claim scans for leases that have stopped being renewed. Ordering by the
-- heartbeat is also what makes the sweep cheap: the interesting rows are the
-- oldest ones.
create index if not exists wa_session_leases_heartbeat_idx
  on wa_session_leases (heartbeat_at);

------------------------------------------------------------------------------
-- Asking the owner for a restart
--
-- `POST /sessions/:id/connect` used to stop and start the socket in whichever
-- worker answered the HTTP call, which was fine when there was only ever one.
-- With several, the request lands on a worker chosen by the platform's load
-- balancer and the socket usually lives somewhere else.
--
-- So the request stops doing the work and records that it was asked: bump the
-- counter, and the worker that owns the clinic notices on its next reconcile
-- and restarts for real. A counter rather than a boolean because two clicks
-- ten seconds apart are two restarts, and a flag that was already true would
-- swallow the second one.
--
-- The QR that comes back needs no routing at all: it is written to
-- whatsapp_sessions.qr and the notify trigger already pushes it to the browser,
-- so a code produced by worker 3 appears in a tab talking to worker 1 the same
-- way it always did.
------------------------------------------------------------------------------
alter table whatsapp_sessions
  add column if not exists restart_seq bigint not null default 0;

------------------------------------------------------------------------------
-- Asking the owner to log out properly
--
-- Disconnecting is not just "stop the socket": it tells WhatsApp to unlink the
-- device, which is what makes the entry disappear from the phone's linked
-- devices list. That call needs the live socket, so only the owner can make
-- it. A worker that is asked to disconnect a clinic it does not hold records
-- the request here; the owner performs the real logout on its next reconcile
-- and clears the flag.
--
-- Without it the fallback is still safe -- the auth state is deleted either
-- way, so the session cannot be resumed -- but the clinic's phone keeps
-- showing a linked device that no longer does anything, which is exactly the
-- kind of small wrongness nobody can explain a year later.
------------------------------------------------------------------------------
alter table whatsapp_sessions
  add column if not exists logout_requested boolean not null default false;

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
begin
  execute 'alter table wa_session_leases enable row level security';
  execute 'drop policy if exists tenant_isolation on wa_session_leases';
  execute
    'create policy tenant_isolation on wa_session_leases for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())';
end $$;
