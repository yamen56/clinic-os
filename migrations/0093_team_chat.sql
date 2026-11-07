-- The clinic team talking to each other.
--
-- Yamen, 2026-11-07: "an internal team chat, the clinic team can chat with each
-- other, so the team members get notified when the other team members need
-- something". One room for the whole clinic, private conversations between two
-- people, named groups, and photos, files and voice notes.
--
-- Separate from `conversations` and `messages`, which are WhatsApp: a row there
-- needs a phone number, and the worker sends anything queued in it.
--
-- Privacy is the point of the policies below. A thread is readable by the people
-- in it, and by nobody else in the clinic: not the owner, and not a super admin,
-- which is why none of them has the usual `app_is_admin()` escape. Joining is done
-- by the security definer functions here, which check that everybody joined
-- belongs to the clinic, because a foreign key does not see row security.

create table if not exists team_threads (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  kind text not null check (kind in ('clinic', 'direct', 'group')),
  name text check (name is null or length(name) between 1 and 60),
  -- The two people of a direct thread, smaller id first: one thread per pair.
  direct_key text,
  created_by uuid references users(id) on delete set null,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists team_threads_clinic_room on team_threads (clinic_id) where kind = 'clinic';
create unique index if not exists team_threads_direct on team_threads (clinic_id, direct_key) where kind = 'direct';

create table if not exists team_thread_members (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references team_threads(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  -- Per person, so opening a thread clears it for them and nobody else.
  unread integer not null default 0,
  muted boolean not null default false,
  last_read_at timestamptz,
  left_at timestamptz,
  joined_at timestamptz not null default now(),
  unique (thread_id, user_id)
);
create index if not exists team_thread_members_user_idx on team_thread_members (user_id, clinic_id) where left_at is null;

create table if not exists team_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  thread_id uuid not null references team_threads(id) on delete cascade,
  -- Null once the sender's account is erased: the message stays, unsigned.
  sender_id uuid references users(id) on delete set null,
  body text not null default '' check (length(body) <= 4000),
  file_path text,
  file_name text check (file_name is null or length(file_name) <= 200),
  file_mime text,
  file_size integer,
  -- A voice note's length, which the player shows before it has loaded.
  file_seconds numeric(6, 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists team_messages_thread_idx on team_messages (thread_id, created_at desc);

-- Is the person asking in this thread, in this clinic, and still on its staff?
-- Security definer so the policies can ask it without reading themselves.
create or replace function app_team_member(p_thread uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from team_thread_members tm
      join team_threads t on t.id = tm.thread_id
      join clinic_members cm on cm.clinic_id = t.clinic_id and cm.user_id = tm.user_id and cm.active
     where tm.thread_id = p_thread
       and tm.user_id = app_user_id()
       and tm.left_at is null
       and t.clinic_id = app_clinic_id()
  )
$$;

do $$ declare t text; begin
  foreach t in array array['team_threads', 'team_thread_members', 'team_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('drop policy if exists team_read on %I', t);
    execute format('drop policy if exists team_write on %I', t);
    execute format('drop policy if exists team_own on %I', t);
  end loop;
end $$;

create policy team_read on team_threads for select to clinicos_app
  using (clinic_id = app_clinic_id() and app_team_member(id));
create policy team_write on team_threads for update to clinicos_app
  using (clinic_id = app_clinic_id() and app_team_member(id))
  with check (clinic_id = app_clinic_id());

create policy team_read on team_thread_members for select to clinicos_app
  using (clinic_id = app_clinic_id() and app_team_member(thread_id));
-- Your own row only: reading, muting, leaving.
create policy team_own on team_thread_members for update to clinicos_app
  using (clinic_id = app_clinic_id() and user_id = app_user_id())
  with check (clinic_id = app_clinic_id() and user_id = app_user_id());

create policy team_read on team_messages for select to clinicos_app
  using (clinic_id = app_clinic_id() and app_team_member(thread_id));
create policy team_write on team_messages for insert to clinicos_app
  with check (clinic_id = app_clinic_id() and sender_id = app_user_id() and app_team_member(thread_id));
-- Deleting is the sender's, and is a mark: the thread says a message was there.
create policy team_own on team_messages for update to clinicos_app
  using (clinic_id = app_clinic_id() and sender_id = app_user_id() and app_team_member(thread_id))
  with check (clinic_id = app_clinic_id() and sender_id = app_user_id());

drop trigger if exists team_threads_touch on team_threads;
create trigger team_threads_touch before update on team_threads for each row execute function touch_updated_at();

-- The whole-clinic room: everybody on the staff is in it, and joins it on joining.
create or replace function team_clinic_room_sync() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room uuid;
begin
  if not new.active then return null; end if;
  insert into team_threads (clinic_id, kind) values (new.clinic_id, 'clinic')
    on conflict (clinic_id) where kind = 'clinic' do nothing;
  select id into v_room from team_threads where clinic_id = new.clinic_id and kind = 'clinic';
  insert into team_thread_members (thread_id, clinic_id, user_id) values (v_room, new.clinic_id, new.user_id)
    on conflict (thread_id, user_id) do update set left_at = null;
  return null;
end $$;
drop trigger if exists clinic_members_team_room on clinic_members;
create trigger clinic_members_team_room after insert or update of active on clinic_members
  for each row execute function team_clinic_room_sync();

insert into team_threads (clinic_id, kind) select id, 'clinic' from clinics
  on conflict (clinic_id) where kind = 'clinic' do nothing;
insert into team_thread_members (thread_id, clinic_id, user_id)
  select t.id, t.clinic_id, cm.user_id
    from team_threads t join clinic_members cm on cm.clinic_id = t.clinic_id and cm.active
   where t.kind = 'clinic'
  on conflict (thread_id, user_id) do nothing;

-- Only people on this clinic's active staff, whatever ids the browser sent.
create or replace function team_staff_only(p_users uuid[]) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct cm.user_id), '{}')
    from clinic_members cm
   where cm.clinic_id = app_clinic_id() and cm.active and cm.user_id = any(p_users)
$$;

-- A private thread between the person asking and one colleague: the one they already have, or a new one.
create or replace function app_team_open_direct(p_other uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := app_user_id(); v_pair uuid[]; v_key text; v_id uuid;
begin
  v_pair := team_staff_only(array[v_me, p_other]);
  if p_other = v_me or coalesce(array_length(v_pair, 1), 0) <> 2 then return null; end if;
  v_key := least(v_me::text, p_other::text) || ':' || greatest(v_me::text, p_other::text);
  insert into team_threads (clinic_id, kind, direct_key, created_by) values (app_clinic_id(), 'direct', v_key, v_me)
    on conflict (clinic_id, direct_key) where kind = 'direct' do nothing;
  select id into v_id from team_threads where clinic_id = app_clinic_id() and kind = 'direct' and direct_key = v_key;
  insert into team_thread_members (thread_id, clinic_id, user_id)
    select v_id, app_clinic_id(), u from unnest(v_pair) u
    on conflict (thread_id, user_id) do update set left_at = null;
  return v_id;
end $$;

-- A named group, the person asking in it.
create or replace function app_team_create_group(p_name text, p_users uuid[]) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_people uuid[];
begin
  v_people := team_staff_only(array_append(p_users, app_user_id()));
  if not app_user_id() = any(v_people) or length(trim(coalesce(p_name, ''))) = 0 then return null; end if;
  insert into team_threads (clinic_id, kind, name, created_by) values (app_clinic_id(), 'group', left(trim(p_name), 60), app_user_id())
    returning id into v_id;
  insert into team_thread_members (thread_id, clinic_id, user_id) select v_id, app_clinic_id(), u from unnest(v_people) u;
  return v_id;
end $$;

-- Anyone in a group may bring colleagues into it.
create or replace function app_team_add(p_thread uuid, p_users uuid[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  if not app_team_member(p_thread) or not exists (select 1 from team_threads where id = p_thread and kind = 'group') then return 0; end if;
  insert into team_thread_members (thread_id, clinic_id, user_id)
    select p_thread, app_clinic_id(), u from unnest(team_staff_only(p_users)) u
    on conflict (thread_id, user_id) do update set left_at = null, joined_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

/*
  A message sent: everybody else in the thread gets one more unread, and one line
  on the bell for the thread, replaced by the latest rather than piling up. The old
  line is deleted and a new one made, not updated, so it pops up and pushes again
  like any new notification. Muted people keep the unread count and get no line.
  Only the sender's own message, sent from this clinic, does anything.
*/
create or replace function app_team_notify(p_message uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m record; r record; v_key text; v_title text; v_body text;
begin
  select tm.id, tm.thread_id, tm.clinic_id, tm.sender_id, tm.body, tm.file_mime, tm.file_name, tm.created_at,
         t.kind, t.name, c.slug, u.full_name as sender_name
    into m
    from team_messages tm
    join team_threads t on t.id = tm.thread_id
    join clinics c on c.id = tm.clinic_id
    left join users u on u.id = tm.sender_id
   where tm.id = p_message;
  if m.id is null or m.sender_id is distinct from app_user_id() or m.clinic_id <> app_clinic_id() then return; end if;

  update team_threads set last_message_at = m.created_at where id = m.thread_id;

  for r in
    select x.user_id, x.muted, coalesce(us.locale, 'ar') as locale
      from team_thread_members x
      join clinic_members cm on cm.clinic_id = m.clinic_id and cm.user_id = x.user_id and cm.active
      join users us on us.id = x.user_id
     where x.thread_id = m.thread_id and x.left_at is null and x.user_id <> m.sender_id
  loop
    update team_thread_members set unread = unread + 1 where thread_id = m.thread_id and user_id = r.user_id;
    continue when r.muted;
    v_key := 'team:' || m.thread_id || ':' || r.user_id;
    delete from notifications where dedupe_key = v_key;
    v_title := coalesce(m.sender_name, case when r.locale = 'en' then 'A colleague' else 'زميل' end)
      || case
           when m.kind = 'clinic' then case when r.locale = 'en' then ' · Whole team' else ' · الفريق كله' end
           when m.kind = 'group' then ' · ' || m.name
           else ''
         end;
    v_body := case
      when length(trim(m.body)) > 0 then m.body
      when m.file_mime like 'image/%' then case when r.locale = 'en' then 'Photo' else 'صورة' end
      when m.file_mime like 'audio/%' then case when r.locale = 'en' then 'Voice note' else 'رسالة صوتية' end
      else coalesce(m.file_name, case when r.locale = 'en' then 'File' else 'ملف' end)
    end;
    perform app_notify(m.clinic_id, r.user_id, 'team_message', left(v_title, 300), left(v_body, 300),
      '/c/' || m.slug || '/conversations/team?t=' || m.thread_id, v_key, 'team');
  end loop;
end $$;

-- Realtime. A thread's messages reach only its people's tabs; the room's reach the clinic.
create or replace function emit_team_message() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare rec record; v_kind text; v_users json;
begin
  rec := coalesce(new, old);
  select kind into v_kind from team_threads where id = rec.thread_id;
  if v_kind <> 'clinic' then
    select json_agg(user_id) into v_users from team_thread_members where thread_id = rec.thread_id and left_at is null;
  end if;
  perform pg_notify('app_events', json_build_object(
    't', 'team_messages', 'op', lower(tg_op), 'id', rec.thread_id, 'clinic_id', rec.clinic_id, 'user_ids', v_users
  )::text);
  return null;
end $$;
drop trigger if exists team_messages_emit on team_messages;
create trigger team_messages_emit after insert or update on team_messages for each row execute function emit_team_message();

-- A person's own unread counts and memberships, to that person only.
create or replace function emit_team_member() returns trigger
language plpgsql as $$
begin
  perform pg_notify('app_events', json_build_object(
    't', 'team_thread_members', 'op', lower(tg_op), 'id', new.thread_id, 'clinic_id', new.clinic_id, 'user_id', new.user_id
  )::text);
  return null;
end $$;
drop trigger if exists team_thread_members_emit on team_thread_members;
create trigger team_thread_members_emit after insert or update on team_thread_members for each row execute function emit_team_member();
