import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { apiClinic } from "@/lib/clinic-api";
import type { ClinicAccess } from "@/lib/auth";

/**
 * The clinic team's own chat (0093): one room for everybody, private threads
 * between two people, named groups.
 *
 * Every member of the staff has it, whatever their access. It needs no
 * capability because it is not a window onto the clinic's data, only onto what
 * colleagues chose to say to them, and who may read a thread is decided in the
 * database by who is in it. What it does need is a membership: a super admin on
 * a support visit has none, and private conversations between staff are not what
 * a support visit is for.
 */

export type TeamPerson = {
  userId: string;
  memberId: string | null;
  name: string;
  hasPhoto: boolean;
  color: string | null;
  /** In a thread's member list: when they last read it, for "seen". */
  lastReadAt?: string | null;
};

/** A message as quoted or pinned: who, and enough of it to recognise. */
export type TeamQuote = { id: string; senderId: string | null; senderName: string | null; body: string; fileMime: string | null; fileName: string | null; deleted: boolean };

export type TeamThread = {
  id: string;
  kind: "clinic" | "direct" | "group";
  name: string | null;
  members: TeamPerson[];
  unread: number;
  muted: boolean;
  /** Pinned to the top of this person's list. */
  pinned: boolean;
  /** The message pinned at the top of the thread, for everybody in it. */
  pinnedMessage: TeamQuote | null;
  lastMessageAt: string | null;
  last: { senderId: string | null; senderName: string | null; body: string; fileMime: string | null; fileName: string | null; deleted: boolean } | null;
};

export type TeamMessage = {
  id: string;
  threadId: string;
  senderId: string | null;
  senderName: string | null;
  body: string;
  file: { name: string; mime: string; size: number; seconds: number | null } | null;
  deleted: boolean;
  createdAt: string;
  replyTo: TeamQuote | null;
  editedAt: string | null;
  forwarded: boolean;
  mentions: string[];
  /** Each emoji once, with who chose it, in the order they were first chosen. */
  reactions: { emoji: string; userIds: string[] }[];
};

export { EDIT_MINUTES, QUICK_REACTIONS } from "./team-chat-shared";

/** How many messages a thread opens on, and how many each "earlier" brings. */
export const PAGE = 60;

/** Larger than anything a phone camera makes, smaller than a scan nobody can open. */
export const MAX_FILE = 16 * 1024 * 1024;

export async function apiTeam(slug: string): Promise<{ ok: true; access: ClinicAccess } | { ok: false; res: NextResponse }> {
  const g = await apiClinic(slug);
  if (!g.ok) return g;
  if (!g.access.memberId) return { ok: false, res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  return g;
}

const person = (x: Record<string, unknown>): TeamPerson => ({
  userId: x.userId as string,
  memberId: (x.memberId as string) ?? null,
  name: (x.name as string) ?? "",
  hasPhoto: !!x.hasPhoto,
  color: (x.color as string) ?? null,
  ...("lastReadAt" in x ? { lastReadAt: x.lastReadAt ? new Date(x.lastReadAt as string).toISOString() : null } : {}),
});

const quote = (x: Record<string, unknown> | null): TeamQuote | null =>
  x && x.id
    ? {
        id: x.id as string,
        senderId: (x.senderId as string) ?? null,
        senderName: (x.senderName as string) ?? null,
        body: x.deleted ? "" : ((x.body as string) ?? ""),
        fileMime: x.deleted ? null : ((x.fileMime as string) ?? null),
        fileName: x.deleted ? null : ((x.fileName as string) ?? null),
        deleted: !!x.deleted,
      }
    : null;

/** The same shape for a quoted or pinned message, from the row it is in. */
const quoteSql = (alias: string) =>
  `case when ${alias}.id is null then null else json_build_object('id', ${alias}.id, 'senderId', ${alias}.sender_id,
     'senderName', (select full_name from users where id = ${alias}.sender_id), 'body', left(${alias}.body, 300),
     'fileMime', ${alias}.file_mime, 'fileName', ${alias}.file_name, 'deleted', ${alias}.deleted_at is not null) end`;

/** This person's threads: the room first, then what they pinned, then the latest. Row security keeps out the rest. */
export async function loadThreads(c: PoolClient, clinicId: string, userId: string): Promise<TeamThread[]> {
  const r = await c.query(
    `select t.id, t.kind, t.name, t.last_message_at, me.unread, me.muted, me.pinned_at,
            ${quoteSql("pm")} as pinned_message,
            (select coalesce(json_agg(json_build_object('userId', u.id, 'memberId', cm.id, 'name', u.full_name,
                                                        'hasPhoto', u.avatar_path is not null, 'color', cm.color,
                                                        'lastReadAt', x.last_read_at)
                                      order by u.full_name), '[]'::json)
               from team_thread_members x
               join users u on u.id = x.user_id
               join clinic_members cm on cm.clinic_id = t.clinic_id and cm.user_id = x.user_id and cm.active
              where x.thread_id = t.id and x.left_at is null) as members,
            lm.sender_id, su.full_name as sender_name, lm.body, lm.file_mime, lm.file_name, lm.deleted_at
       from team_thread_members me
       join team_threads t on t.id = me.thread_id
       left join lateral (select * from team_messages m where m.thread_id = t.id order by m.created_at desc limit 1) lm on true
       left join users su on su.id = lm.sender_id
       left join team_messages pm on pm.id = t.pinned_message_id and pm.deleted_at is null
      where me.user_id = $2 and me.left_at is null and t.clinic_id = $1
      order by (t.kind = 'clinic') desc, me.pinned_at desc nulls last, coalesce(t.last_message_at, t.created_at) desc
      limit 200`,
    [clinicId, userId]
  );
  return r.rows.map((x) => ({
    id: x.id,
    kind: x.kind,
    name: x.name ?? null,
    members: (x.members as Record<string, unknown>[]).map(person),
    unread: Number(x.unread),
    muted: !!x.muted,
    pinned: !!x.pinned_at,
    pinnedMessage: quote(x.pinned_message),
    lastMessageAt: x.last_message_at ? new Date(x.last_message_at).toISOString() : null,
    last:
      x.body != null || x.file_mime != null
        ? {
            senderId: x.sender_id ?? null,
            senderName: x.sender_name ?? null,
            body: x.deleted_at ? "" : (x.body ?? ""),
            fileMime: x.deleted_at ? null : (x.file_mime ?? null),
            fileName: x.deleted_at ? null : (x.file_name ?? null),
            deleted: !!x.deleted_at,
          }
        : null,
  }));
}

/** A page of a thread, oldest first, ending before \`before\` when it is given. */
export async function loadMessages(c: PoolClient, threadId: string, before: string | null): Promise<TeamMessage[]> {
  const r = await c.query(
    `select * from (
       select m.id, m.thread_id, m.sender_id, u.full_name as sender_name, m.body, m.file_path, m.file_name, m.file_mime,
              m.file_size, m.file_seconds::float as file_seconds, m.deleted_at, m.created_at,
              m.edited_at, m.forwarded, m.mentions, ${quoteSql("q")} as reply,
              (select coalesce(json_agg(json_build_object('emoji', g.emoji, 'userIds', g.users) order by g.first), '[]'::json)
                 from (select r.emoji, json_agg(r.user_id order by r.created_at) as users, min(r.created_at) as first
                         from team_reactions r where r.message_id = m.id group by r.emoji) g) as reactions
         from team_messages m left join users u on u.id = m.sender_id
         left join team_messages q on q.id = m.reply_to
        where m.thread_id = $1 and ($2::timestamptz is null or m.created_at < $2::timestamptz)
        order by m.created_at desc
        limit ${PAGE}) x
      order by x.created_at`,
    [threadId, before]
  );
  return r.rows.map((x) => ({
    id: x.id,
    threadId: x.thread_id,
    senderId: x.sender_id ?? null,
    senderName: x.sender_name ?? null,
    body: x.deleted_at ? "" : x.body,
    file:
      x.file_path && !x.deleted_at
        ? { name: x.file_name ?? "file", mime: x.file_mime ?? "application/octet-stream", size: Number(x.file_size ?? 0), seconds: x.file_seconds ?? null }
        : null,
    deleted: !!x.deleted_at,
    createdAt: new Date(x.created_at).toISOString(),
    replyTo: x.deleted_at ? null : quote(x.reply),
    editedAt: x.edited_at && !x.deleted_at ? new Date(x.edited_at).toISOString() : null,
    forwarded: !!x.forwarded,
    mentions: (x.mentions as string[]) ?? [],
    reactions: x.deleted_at ? [] : ((x.reactions as { emoji: string; userIds: string[] }[]) ?? []),
  }));
}

export type TeamHit = { threadId: string; messageId: string; senderName: string | null; body: string; createdAt: string };

/** Words across every thread this person is in, the latest first, Arabic spelled either way. Row security keeps it to their threads. */
export async function searchMessages(c: PoolClient, clinicId: string, q: string): Promise<TeamHit[]> {
  const r = await c.query(
    `select m.id, m.thread_id, u.full_name as sender_name, m.body, m.created_at
       from team_messages m left join users u on u.id = m.sender_id
      where m.clinic_id = $1 and m.deleted_at is null
        and (ar_normalize(m.body) like '%' || ar_normalize($2) || '%' or m.file_name ilike '%' || $2 || '%')
      order by m.created_at desc
      limit 40`,
    [clinicId, q]
  );
  return r.rows.map((x) => ({
    threadId: x.thread_id,
    messageId: x.id,
    senderName: x.sender_name ?? null,
    body: x.body || "",
    createdAt: new Date(x.created_at).toISOString(),
  }));
}

/** Everybody on the staff, to start a conversation or a group with. */
export async function loadTeamPeople(c: PoolClient, clinicId: string): Promise<TeamPerson[]> {
  const r = await c.query(
    `select u.id as "userId", cm.id as "memberId", u.full_name as name, u.avatar_path is not null as "hasPhoto", cm.color
       from clinic_members cm join users u on u.id = cm.user_id
      where cm.clinic_id = $1 and cm.active
      order by u.full_name`,
    [clinicId]
  );
  return r.rows.map(person);
}

/** What this person has not read, across every thread they have not muted. */
export async function teamUnread(c: PoolClient, clinicId: string, userId: string): Promise<number> {
  const r = await c.query(
    `select coalesce(sum(unread), 0)::int as n from team_thread_members
      where clinic_id = $1 and user_id = $2 and left_at is null and not muted`,
    [clinicId, userId]
  );
  return Number(r.rows[0].n);
}
