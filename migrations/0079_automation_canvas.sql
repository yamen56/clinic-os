-- Automations as a graph: a canvas builder, more of the clinic's own events,
-- and an engine that can be edited while it is running.
--
-- Until now a flow was a tree. Steps hung off one another by parent and branch,
-- and "what runs next" was worked out at run time by walking back up it. That
-- shape cannot be drawn on a canvas where two branches meet again, and it was
-- saved by deleting every step and writing it out afresh, which quietly
-- restarted every run that was half-way through: a patient waiting three hours
-- for a review request was sent back to step one the moment anybody fixed a
-- typo in it.
--
-- So each step now keeps its id across saves, and what follows it is an edge:
-- one row per output. A plain step has one ("next"); an if/else has "yes" and
-- "no"; waiting for a reply has one per expected answer plus "other" and
-- "timeout".

------------------------------------------------------------------------------
-- 1. Edges
------------------------------------------------------------------------------
create table if not exists automation_edges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  automation_id uuid not null references automations(id) on delete cascade,
  -- null = the trigger itself: the edge into the first step.
  from_step_id uuid references automation_steps(id) on delete cascade,
  handle text not null default 'next'
    check (handle ~ '^(next|yes|no|replied|timeout|other|opt:[0-9]{1,2})$'),
  to_step_id uuid not null references automation_steps(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- One edge per output. Several outputs may lead into the same step (that is
-- what lets two branches meet), but one output never leads two ways.
create unique index if not exists automation_edges_out_key
  on automation_edges (automation_id, from_step_id, handle) nulls not distinct;
create index if not exists automation_edges_to_idx on automation_edges (to_step_id);

------------------------------------------------------------------------------
-- 2. Steps: where they sit on the canvas, and the new kinds
------------------------------------------------------------------------------
alter table automation_steps add column if not exists position jsonb;
alter table automation_steps add column if not exists label text not null default '';

alter table automation_steps drop constraint if exists automation_steps_step_type_check;
alter table automation_steps add constraint automation_steps_step_type_check
  check (step_type in (
    'send_whatsapp', 'send_document',
    'wait', 'wait_for_reply',
    'condition', 'goto_automation', 'stop',
    'add_tag', 'remove_tag', 'update_patient', 'add_note',
    'update_appointment',
    'assign_conversation', 'set_ai', 'flag_conversation', 'close_conversation',
    'create_task', 'notify_staff'
  ));

------------------------------------------------------------------------------
-- 3. Every existing tree, as edges
------------------------------------------------------------------------------
/*
  Reproduces the old engine's nextAfter() exactly, so a run that is waiting
  right now resumes where it would have: after a step comes its next sibling,
  or, at the end of a branch, whatever came after the if/else that held it.
  An if/else whose branch was empty carried straight on the same way. A stop
  ends the run, so it gets no edge.
*/
create or replace function automation_tree_cont(p_step uuid) returns uuid
language plpgsql stable as $$
declare
  s automation_steps%rowtype;
  nxt uuid;
begin
  select * into s from automation_steps where id = p_step;
  if not found then return null; end if;
  select x.id into nxt from automation_steps x
   where x.automation_id = s.automation_id
     and x.parent_step_id is not distinct from s.parent_step_id
     and (s.parent_step_id is null or x.branch is not distinct from s.branch)
     and (x.sort > s.sort or (x.sort = s.sort and x.id > s.id))
   order by x.sort, x.id
   limit 1;
  if nxt is not null then return nxt; end if;
  if s.parent_step_id is null then return null; end if;
  return automation_tree_cont(s.parent_step_id);
end $$;

do $$
declare
  a record;
  s record;
  br text;
  tgt uuid;
begin
  for a in
    select x.id, x.clinic_id from automations x
     where not exists (select 1 from automation_edges e where e.automation_id = x.id)
  loop
    select id into tgt from automation_steps
     where automation_id = a.id and parent_step_id is null
     order by sort, id limit 1;
    if tgt is not null then
      insert into automation_edges (clinic_id, automation_id, from_step_id, handle, to_step_id)
      values (a.clinic_id, a.id, null, 'next', tgt);
    end if;

    for s in select * from automation_steps where automation_id = a.id loop
      continue when s.step_type = 'stop';
      if s.step_type = 'condition' then
        foreach br in array array['yes', 'no'] loop
          select id into tgt from automation_steps
           where parent_step_id = s.id and branch = br
           order by sort, id limit 1;
          if tgt is null then tgt := automation_tree_cont(s.id); end if;
          if tgt is not null then
            insert into automation_edges (clinic_id, automation_id, from_step_id, handle, to_step_id)
            values (a.clinic_id, a.id, s.id, br, tgt);
          end if;
        end loop;
      else
        tgt := automation_tree_cont(s.id);
        if tgt is not null then
          insert into automation_edges (clinic_id, automation_id, from_step_id, handle, to_step_id)
          values (a.clinic_id, a.id, s.id, 'next', tgt);
        end if;
      end if;
    end loop;
  end loop;
end $$;

drop function automation_tree_cont(uuid);

------------------------------------------------------------------------------
-- 4. Automations: how often a patient may go through, when to stop early,
--    and where the trigger sits on the canvas
------------------------------------------------------------------------------
-- {} is how every flow behaved until now: every time, never stopped early.
alter table automations add column if not exists settings jsonb not null default '{}';
alter table automations add column if not exists canvas jsonb not null default '{}';

------------------------------------------------------------------------------
-- 5. Runs
------------------------------------------------------------------------------
-- What a waiting run is waiting for. A reply can wake it as well as the clock.
alter table automation_runs add column if not exists waiting_for text
  check (waiting_for in ('time', 'reply'));
update automation_runs set waiting_for = 'time' where status = 'waiting' and waiting_for is null;

-- How many automations deep this run was started: one flow confirming an
-- appointment starts the flows that listen for confirmations, and so on. The
-- engine stops the chain before it can go round in a circle.
alter table automation_runs add column if not exists chain_depth integer not null default 0;

/*
  One active run per automation per context, again.

  0004 made the dedupe index treat NULLs as equal, which is what makes it mean
  anything: nearly every run has some of these columns empty. 0010 rebuilt the
  index to add document_id and dropped that clause on the way, so since then a
  replayed trigger could start the same flow twice for the same patient.
  conversation_id joins the key so two different unknown numbers writing in at
  once are two runs, not one.

  Duplicates already running are cancelled first (the oldest is kept), or the
  index could not be built.
*/
update automation_runs r set status = 'cancelled', finished_at = now(), error = 'duplicate'
 where r.id in (
   select id from (
     select id, row_number() over (
              partition by automation_id, patient_id, appointment_id, invoice_id, document_id, conversation_id
              order by started_at, id) as n
       from automation_runs
      where status in ('running', 'waiting')
   ) d
   where d.n > 1
 );
drop index if exists automation_runs_dedupe;
create unique index automation_runs_dedupe
  on automation_runs (automation_id, patient_id, appointment_id, invoice_id, document_id, conversation_id)
  nulls not distinct
  where status in ('running', 'waiting');

-- A patient's reply finds the runs waiting for it by patient, or by thread when
-- the number has no file yet.
create index if not exists automation_runs_reply_patient_idx
  on automation_runs (clinic_id, patient_id) where status = 'waiting' and waiting_for = 'reply';
create index if not exists automation_runs_reply_conv_idx
  on automation_runs (conversation_id) where status = 'waiting' and waiting_for = 'reply';

alter table automation_run_logs drop constraint if exists automation_run_logs_status_check;
alter table automation_run_logs add constraint automation_run_logs_status_check
  check (status in ('ok', 'skipped', 'failed', 'waiting', 'cancelled'));

-- The activity counts on each step of the canvas.
create index if not exists automation_run_logs_step_idx on automation_run_logs (step_id, created_at)
  where step_id is not null;

------------------------------------------------------------------------------
-- 6. The clinic's review page, for {{clinic.review_link}}
------------------------------------------------------------------------------
alter table clinics add column if not exists google_review_url text;

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['automation_edges'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;
