/*
  A record of every time the agency goes inside a clinic.

  Before this, the "Open workspace" button wrote one audit row on the way in and
  one on the way out, and that was the whole account of it. It was also the
  only door that wrote anything. Any super admin could type /c/<slug> and be
  inside with owner access — including the ones whose access set does not hold
  `clinics.impersonate` — and nothing anywhere said they had been. A support
  session was not tied to the clinic it was opened for either, so editing the
  URL walked into a second clinic on the first one's audit row. And a visit
  nobody ended with the button lasted as long as the session: thirty days.

  So entering a clinic is now a visit, and a visit is a row:

    - who (copied, so the record survives the admin's account being removed),
    - which clinic, and why — a reason is required to open one,
    - from where, and on what,
    - when it started, when it was last used, and when and how it ended.

  `sessions.support_visit_id` binds a support session to its visit, and through
  it to exactly one clinic; `requireClinic` admits an agency admin with no
  membership only inside the clinic their open visit names. The visit carries
  its own `expires_at`, which the session copies, so support access ends by
  itself instead of lasting a month.
*/

create table if not exists support_visits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  admin_user_id uuid references users(id) on delete set null,
  admin_name text not null,
  admin_email text not null,
  reason text not null check (length(btrim(reason)) between 3 and 300),
  ip text,
  user_agent text,
  started_at timestamptz not null default now(),
  -- Moved forward with the session's own last_seen_at, so to the same fifteen
  -- minute resolution — see getSession. It is what "timed out" reports as the
  -- end, because nobody was there at the expiry.
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('exit', 'switched', 'signed_out', 'expired'))
);

create index if not exists support_visits_clinic_idx on support_visits (clinic_id, started_at desc);
create index if not exists support_visits_admin_idx on support_visits (admin_user_id, started_at desc);

alter table sessions
  add column if not exists support_visit_id uuid references support_visits(id) on delete set null;

/*
  A visit ends when its session does, whichever way the session goes.

  Exiting and switching clinics set their own end before deleting the session,
  so they keep their reasons. Everything else — signing out, an expiry swept up
  by the worker, a password reset that clears every session, the admin being
  removed — lands here. Doing it in the database rather than at each of those
  call sites is the point: a path that forgets to close the visit is a visit
  that reads as still open forever.

  An expired session is swept a day after it expires, so "now" is not when it
  ended. The last time it was used is.
*/
create or replace function support_visit_close() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update support_visits
     set ended_at = case
           when old.expires_at <= now()
             then least(greatest(last_seen_at, old.last_seen_at), old.expires_at)
           else now()
         end,
         end_reason = case when old.expires_at <= now() then 'expired' else 'signed_out' end
   where id = old.support_visit_id and ended_at is null;
  return old;
end $$;

drop trigger if exists sessions_close_support_visit on sessions;
create trigger sessions_close_support_visit after delete on sessions
  for each row when (old.support_visit_id is not null)
  execute function support_visit_close();

/*
  The clinic reads its own visits; only the system writes them.

  Not the usual `for all` tenant policy. This is a record kept about the agency
  for the clinic's benefit, and a record the party it describes cannot edit is
  only worth anything if the party it is shown to cannot edit it either.
*/
alter table support_visits enable row level security;
drop policy if exists support_visits_read on support_visits;
create policy support_visits_read on support_visits for select to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id());
drop policy if exists support_visits_write on support_visits;
create policy support_visits_write on support_visits for all to clinicos_app
  using (app_is_admin()) with check (app_is_admin());
