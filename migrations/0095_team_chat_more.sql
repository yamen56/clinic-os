-- The team chat, more like the chat apps everybody already uses.
--
-- Yamen, 2026-11-07: "in the internal chat add more capability and options like
-- the normal social media chat apps, and make sure it notifies the one who got
-- the message in a premium way".
--
-- Replies that quote, reactions, editing for a short while, forwarding, @mentions
-- that reach a muted colleague, a pinned message per thread, threads pinned to
-- the top of one's own list, and "seen". Every new table keeps 0093's rule: a
-- thread's people read it, nobody else, so no `app_is_admin()` escape.

alter table team_messages
  add column if not exists reply_to uuid,
  add column if not exists edited_at timestamptz,
  add column if not exists forwarded boolean not null default false,
  -- Who was @mentioned. Only people in the thread count; the server checks.
  add column if not exists mentions uuid[] not null default '{}';

-- A message is quoted, reacted to and pinned only within its own thread.
create unique index if not exists team_messages_id_thread on team_messages (id, thread_id);
alter table team_messages drop constraint if exists team_messages_reply_same_thread;
alter table team_messages add constraint team_messages_reply_same_thread
  foreign key (reply_to, thread_id) references team_messages (id, thread_id);

-- Pinned to the top of this person's list. Theirs alone, like muting.
alter table team_thread_members add column if not exists pinned_at timestamptz;

-- The one message everybody in the thread sees at the top.
alter table team_threads
  add column if not exists pinned_message_id uuid,
  add column if not exists pinned_by uuid references users(id) on delete set null;
alter table team_threads drop constraint if exists team_threads_pin_same_thread;
alter table team_threads add constraint team_threads_pin_same_thread
  foreign key (pinned_message_id, id) references team_messages (id, thread_id);

-- One reaction per person per message, as in WhatsApp: a new one replaces it.
create table if not exists team_reactions (
  message_id uuid not null,
  thread_id uuid not null references team_threads(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id),
  foreign key (message_id, thread_id) references team_messages (id, thread_id) on delete cascade
);
create index if not exists team_reactions_thread_idx on team_reactions (thread_id);

alter table team_reactions enable row level security;
drop policy if exists team_read on team_reactions;
drop policy if exists team_own on team_reactions;
create policy team_read on team_reactions for select to clinicos_app
  using (clinic_id = app_clinic_id() and app_team_member(thread_id));
create policy team_own on team_reactions for all to clinicos_app
  using (clinic_id = app_clinic_id() and user_id = app_user_id() and app_team_member(thread_id))
  with check (clinic_id = app_clinic_id() and user_id = app_user_id() and app_team_member(thread_id));

-- A reaction reaches the thread's tabs the way a message does.
drop trigger if exists team_reactions_emit on team_reactions;
create trigger team_reactions_emit after insert or update or delete on team_reactions
  for each row execute function emit_team_message();

-- A thread renamed, or a message pinned in it, reaches its people's tabs as a message would.
create or replace function emit_team_thread() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_users json;
begin
  if new.kind <> 'clinic' then
    select json_agg(user_id) into v_users from team_thread_members where thread_id = new.id and left_at is null;
  end if;
  perform pg_notify('app_events', json_build_object(
    't', 'team_messages', 'op', 'update', 'id', new.id, 'clinic_id', new.clinic_id, 'user_ids', v_users
  )::text);
  return null;
end $$;
drop trigger if exists team_threads_emit on team_threads;
create trigger team_threads_emit after update of name, pinned_message_id on team_threads
  for each row execute function emit_team_thread();

-- Who a notification is from, so the pop-up and the phone can show their face.
alter table notifications add column if not exists actor_id uuid references users(id) on delete set null;

/*
  "Seen" needs the others to hear that somebody read. A member row used to reach
  only its own person; now a read in a private thread or a group reaches everybody
  in it. The whole-clinic room stays with its own person, or every glance at it
  would make every tab in the clinic reload.
*/
create or replace function emit_team_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_kind text; v_users json;
begin
  select kind into v_kind from team_threads where id = new.thread_id;
  if v_kind <> 'clinic' and (tg_op = 'INSERT' or new.last_read_at is distinct from old.last_read_at or new.left_at is distinct from old.left_at) then
    select json_agg(user_id) into v_users from team_thread_members where thread_id = new.thread_id and (left_at is null or user_id = new.user_id);
    perform pg_notify('app_events', json_build_object(
      't', 'team_thread_members', 'op', lower(tg_op), 'id', new.thread_id, 'clinic_id', new.clinic_id, 'user_ids', v_users
    )::text);
  else
    perform pg_notify('app_events', json_build_object(
      't', 'team_thread_members', 'op', lower(tg_op), 'id', new.thread_id, 'clinic_id', new.clinic_id, 'user_id', new.user_id
    )::text);
  end if;
  return null;
end $$;

/*
  A message sent, as in 0093, and now:
  - an @mention, or a reply to your own message, reaches you even in a thread you
    muted, and says so in its title;
  - the line on the bell remembers who sent it, for their photo.
*/
create or replace function app_team_notify(p_message uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m record; r record; v_key text; v_title text; v_body text; v_to_me boolean; v_mentioned boolean; v_where text;
begin
  select tm.id, tm.thread_id, tm.clinic_id, tm.sender_id, tm.body, tm.file_mime, tm.file_name, tm.created_at, tm.mentions,
         tm.forwarded, q.sender_id as quoted_sender,
         t.kind, t.name, c.slug, u.full_name as sender_name
    into m
    from team_messages tm
    join team_threads t on t.id = tm.thread_id
    join clinics c on c.id = tm.clinic_id
    left join users u on u.id = tm.sender_id
    left join team_messages q on q.id = tm.reply_to
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
    -- Never null: a null here would let `continue when` through, and a muted thread ring.
    v_mentioned := coalesce(r.user_id = any(m.mentions), false);
    v_to_me := coalesce(m.quoted_sender = r.user_id, false);
    continue when r.muted and not v_mentioned and not v_to_me;
    v_key := 'team:' || m.thread_id || ':' || r.user_id;
    delete from notifications where dedupe_key = v_key;
    v_where := case
      when m.kind = 'clinic' then case when r.locale = 'en' then 'Whole team' else 'الفريق كله' end
      when m.kind = 'group' then m.name
    end;
    v_title := coalesce(m.sender_name, case when r.locale = 'en' then 'A colleague' else 'زميل' end)
      || case
           when v_mentioned then case when r.locale = 'en' then ' mentioned you' else ' أشار إليك' end
           when v_to_me then case when r.locale = 'en' then ' replied to you' else ' ردّ عليك' end
           else ''
         end
      || coalesce(' · ' || v_where, '');
    v_body := case
      when length(trim(m.body)) > 0 then m.body
      when m.file_mime like 'image/%' then case when r.locale = 'en' then '📷 Photo' else '📷 صورة' end
      when m.file_mime like 'audio/%' then case when r.locale = 'en' then '🎤 Voice note' else '🎤 رسالة صوتية' end
      else '📎 ' || coalesce(m.file_name, case when r.locale = 'en' then 'File' else 'ملف' end)
    end;
    if m.forwarded then
      v_body := case when r.locale = 'en' then 'Forwarded: ' else 'محوّلة: ' end || v_body;
    end if;
    perform app_notify(m.clinic_id, r.user_id, 'team_message', left(v_title, 300), left(v_body, 300),
      '/c/' || m.slug || '/conversations/team?t=' || m.thread_id, v_key, 'team');
    update notifications set actor_id = m.sender_id where dedupe_key = v_key;
  end loop;
end $$;

/*
  A reaction, set or changed, tells the person whose message it is, unless they
  reacted to their own or muted the thread. One bell line per reactor per message,
  so changing 👍 to ❤️ replaces it rather than adding a second.
*/
create or replace function app_team_react(p_message uuid, p_emoji text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare m record; v_key text; v_name text; v_locale text; v_muted boolean;
begin
  select tm.id, tm.thread_id, tm.clinic_id, tm.sender_id, tm.body, tm.file_mime, tm.deleted_at, t.kind, t.name, c.slug
    into m
    from team_messages tm join team_threads t on t.id = tm.thread_id join clinics c on c.id = tm.clinic_id
   where tm.id = p_message and tm.clinic_id = app_clinic_id();
  if m.id is null or m.deleted_at is not null or not app_team_member(m.thread_id) then return false; end if;

  if p_emoji is null then
    delete from team_reactions where message_id = p_message and user_id = app_user_id();
    delete from notifications where dedupe_key = 'team-react:' || p_message || ':' || app_user_id();
    return true;
  end if;

  insert into team_reactions (message_id, thread_id, clinic_id, user_id, emoji)
  values (p_message, m.thread_id, m.clinic_id, app_user_id(), p_emoji)
  on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();

  if m.sender_id is null or m.sender_id = app_user_id() then return true; end if;
  select x.muted, coalesce(us.locale, 'ar') into v_muted, v_locale
    from team_thread_members x join users us on us.id = x.user_id
   where x.thread_id = m.thread_id and x.user_id = m.sender_id and x.left_at is null;
  if v_muted is null or v_muted then return true; end if;

  select full_name into v_name from users where id = app_user_id();
  v_key := 'team-react:' || p_message || ':' || app_user_id();
  delete from notifications where dedupe_key = v_key;
  perform app_notify(m.clinic_id, m.sender_id, 'team_reaction',
    left(coalesce(v_name, '') || case when v_locale = 'en' then ' reacted ' else ' تفاعل ' end || p_emoji, 300),
    left(case
      when length(trim(m.body)) > 0 then m.body
      when m.file_mime like 'image/%' then case when v_locale = 'en' then '📷 Photo' else '📷 صورة' end
      when m.file_mime like 'audio/%' then case when v_locale = 'en' then '🎤 Voice note' else '🎤 رسالة صوتية' end
      else '📎'
    end, 300),
    '/c/' || m.slug || '/conversations/team?t=' || m.thread_id || '&m=' || p_message, v_key, 'team');
  update notifications set actor_id = app_user_id() where dedupe_key = v_key;
  return true;
end $$;
