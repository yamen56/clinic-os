import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { apiTeam, loadMessages } from "@/lib/team-chat";

export const dynamic = "force-dynamic";

/** A page of the thread. A thread this person is not in reads as one that does not exist. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; threadId: string }> }) {
  const { slug, threadId } = await ctx.params;
  if (!isUuid(threadId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const before = new URL(req.url).searchParams.get("before");
  const data = await inClinic(g.access, async (c) => {
    const t = (await c.query(`select id from team_threads where id = $1`, [threadId])).rows[0];
    if (!t) return null;
    return { messages: await loadMessages(c, threadId, before && !Number.isNaN(Date.parse(before)) ? before : null) };
  });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(data);
}

const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read") }),
  z.object({ op: z.literal("mute"), muted: z.boolean() }),
  z.object({ op: z.literal("leave") }),
  z.object({ op: z.literal("rename"), name: z.string().trim().min(1).max(60) }),
  z.object({ op: z.literal("add"), userIds: z.array(z.string().uuid()).min(1).max(100) }),
  z.object({ op: z.literal("pin"), pinned: z.boolean() }),
  z.object({ op: z.literal("unread") }),
  z.object({ op: z.literal("typing") }),
]);

/**
 * What a person does to a thread. Reading also clears the thread's line on their
 * bell, which is the same news. Leaving is for groups: the room is the whole
 * staff, and a private thread is left by simply not answering.
 *
 * Pinning a thread and marking it unread are this person's own, like muting.
 * Typing is said, not stored: an event to the thread's other tabs, which show
 * "… is typing" for a few seconds unless it is said again.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; threadId: string }> }) {
  const { slug, threadId } = await ctx.params;
  if (!isUuid(threadId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const parsed = op.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;
  const userId = g.access.session.user.id;

  const result = await inClinic(g.access, async (c) => {
    const t = (await c.query(`select id, kind from team_threads where id = $1`, [threadId])).rows[0];
    if (!t) return "not_found";
    if (d.op === "read") {
      await c.query(`update team_thread_members set unread = 0, last_read_at = now() where thread_id = $1 and user_id = $2 and unread > 0`, [threadId, userId]);
      await c.query(`update notifications set read_at = now() where user_id = $1 and dedupe_key = $2 and read_at is null`, [userId, `team:${threadId}:${userId}`]);
    } else if (d.op === "mute") {
      await c.query(`update team_thread_members set muted = $3 where thread_id = $1 and user_id = $2`, [threadId, userId, d.muted]);
    } else if (d.op === "leave") {
      if (t.kind !== "group") return "invalid";
      await c.query(`update team_thread_members set left_at = now(), unread = 0 where thread_id = $1 and user_id = $2`, [threadId, userId]);
    } else if (d.op === "pin") {
      await c.query(`update team_thread_members set pinned_at = case when $3 then now() end where thread_id = $1 and user_id = $2`, [threadId, userId, d.pinned]);
    } else if (d.op === "unread") {
      await c.query(`update team_thread_members set unread = greatest(unread, 1) where thread_id = $1 and user_id = $2`, [threadId, userId]);
    } else if (d.op === "typing") {
      const people =
        t.kind === "clinic"
          ? null
          : (await c.query(`select coalesce(json_agg(user_id), '[]'::json) as ids from team_thread_members where thread_id = $1 and left_at is null`, [threadId])).rows[0].ids;
      await c.query(`select pg_notify('app_events', $1)`, [
        JSON.stringify({ t: "team_typing", op: "typing", id: threadId, clinic_id: g.access.clinicId, by: userId, user_ids: people }),
      ]);
    } else if (d.op === "rename") {
      if (t.kind !== "group") return "invalid";
      await c.query(`update team_threads set name = $2 where id = $1`, [threadId, d.name]);
    } else {
      const n = (await c.query(`select app_team_add($1, $2::uuid[]) as n`, [threadId, d.userIds])).rows[0].n;
      if (!n) return "invalid";
    }
    return "ok";
  });
  if (result !== "ok") return NextResponse.json({ error: result }, { status: result === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true });
}
