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

export type TeamPerson = { userId: string; memberId: string | null; name: string; hasPhoto: boolean; color: string | null };

export type TeamThread = {
  id: string;
  kind: "clinic" | "direct" | "group";
  name: string | null;
  members: TeamPerson[];
  unread: number;
  muted: boolean;
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
};

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
});

/** This person's threads, the room first, then the latest first. Row security keeps out the rest. */
export async function loadThreads(c: PoolClient, clinicId: string, userId: string): Promise<TeamThread[]> {
  const r = await c.query(
    `select t.id, t.kind, t.name, t.last_message_at, me.unread, me.muted,
            (select coalesce(json_agg(json_build_object('userId', u.id, 'memberId', cm.id, 'name', u.full_name,
                                                        'hasPhoto', u.avatar_path is not null, 'color', cm.color)
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
      where me.user_id = $2 and me.left_at is null and t.clinic_id = $1
      order by (t.kind = 'clinic') desc, coalesce(t.last_message_at, t.created_at) desc
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
              m.file_size, m.file_seconds::float as file_seconds, m.deleted_at, m.created_at
         from team_messages m left join users u on u.id = m.sender_id
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
