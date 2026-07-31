-- What the worker can actually do, written down where the web app can read it.
--
-- The AI settings screen needs to know whether the agent can run. It was asking
-- its own process — `!!process.env.ANTHROPIC_API_KEY` — which is the wrong
-- question twice over: the agent runs in the worker, and the web service has no
-- reason to hold an Anthropic key at all. In production the two disagreed, so
-- the screen showed "add an ANTHROPIC_API_KEY" and disabled the switch while the
-- worker was answering patients perfectly well.
--
-- Two services cannot read each other's environment, so the worker records what
-- it is capable of and the web app reads that. One row, rewritten on every
-- start and refreshed periodically; `updated_at` doubles as a heartbeat, so a
-- worker that has stopped is distinguishable from one that is merely unable to
-- reach Anthropic.

create table if not exists worker_status (
  -- Exactly one row, enforced by the type rather than by convention.
  id boolean primary key default true check (id),
  ai_ready boolean not null default false,
  whatsapp_ready boolean not null default false,
  version text not null default '',
  updated_at timestamptz not null default now()
);

-- Deliberately not seeded. An absent row means "no worker has ever reported",
-- which the app treats as unknown and answers from its own environment — so a
-- developer with no worker running is not told the agent is misconfigured. A
-- seeded row could not say that: `ai_ready = false` would be indistinguishable
-- from a worker that had reported it genuinely cannot reach Anthropic.

-- Not tenant data: it describes the deployment, and every clinic's settings
-- screen needs to read it. So reads are open to the app role regardless of
-- which clinic is in context — there is nothing tenant-specific to leak.
--
-- Writes are a different matter and need the admin context (`app.is_admin`,
-- which is what `withSystem` sets and no ordinary request ever has). A
-- select-only policy would have been worse than none: RLS denies silently, so
-- the heartbeat would have failed on every beat while the screen went on
-- reporting a worker that never reported.
alter table worker_status enable row level security;

drop policy if exists worker_status_read on worker_status;
create policy worker_status_read on worker_status
  for select to clinicos_app using (true);

drop policy if exists worker_status_write on worker_status;
create policy worker_status_write on worker_status
  for all to clinicos_app
  using (app_is_admin())
  with check (app_is_admin());
