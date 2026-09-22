-- What each worker is actually carrying, so the ceiling stops being a guess.
--
-- DEPLOY.md says 60–100 WhatsApp clinics per worker and admits, honestly, that
-- the figure "is still unmeasured — an estimate about one process's memory".
-- That is the worst shape a limit can have. Too low and a worker is added that
-- was not needed; too high and the first anyone learns is a container hitting
-- its memory limit with every clinic's WhatsApp socket inside it, which is the
-- outage that costs a QR rescan per clinic to recover from.
--
-- One Baileys socket holds its own auth state, its own store and a live
-- WebSocket, so the cost per clinic is real and measurable — it was simply
-- never being measured. This is the row each worker writes on its heartbeat.
--
-- Separate from `worker_status` (0016), which is exactly one row describing
-- what the *fleet* can do — `ai_ready`, `whatsapp_ready`. This is one row per
-- process describing what that process is holding, and the two must not be
-- merged: the fleet question is answered by any worker, and this one only ever
-- by the worker it is about.
--
-- Separate from `wa_session_leases` (0054) too, which only exists for clinics a
-- worker owns. A worker holding nothing — just started, or draining jobs — has
-- no lease row and is exactly the worker you want to see before sending
-- sessions to it.

create table if not exists worker_instances (
  -- WORKER_ID from worker/wa/leases.ts. Free text and not a foreign key, for
  -- the same reason the lease's owner is: a worker is a container that may
  -- never come back, not a row in this database.
  worker_id text primary key,
  -- How many WhatsApp sockets this process is holding right now.
  sessions int not null default 0,
  -- Resident set size and heap, in whole megabytes. Whole, because the decision
  -- this feeds is "is another worker needed" and nothing about that turns on a
  -- fraction of a megabyte.
  rss_mb int not null default 0,
  heap_mb int not null default 0,
  version text not null default '',
  started_at timestamptz not null default now(),
  -- The heartbeat. A worker that dies leaves a stale row rather than a wrong
  -- one, and the reader decides how stale is gone — same rule as worker_status.
  updated_at timestamptz not null default now()
);

create index if not exists worker_instances_seen on worker_instances (updated_at);

-- Same shape as the other operations tables (0043, 0056, 0057): no tenant in
-- here to isolate, but a table the app role could empty is a fleet that goes
-- invisible, and every caller runs through withSystem.
alter table worker_instances enable row level security;
drop policy if exists worker_instances_access on worker_instances;
create policy worker_instances_access on worker_instances for all to clinicos_app
  using (app_is_admin())
  with check (app_is_admin());
