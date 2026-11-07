import { NextResponse } from "next/server";
import { z } from "zod";
import { inClinic } from "@/lib/clinic-api";
import { apiTeam, loadTeamPeople, loadThreads, searchMessages, teamUnread } from "@/lib/team-chat";

export const dynamic = "force-dynamic";

/**
 * This person's threads and the staff; with `?count` just what is unread, for the badge; with
 * `?q=` the messages, across their threads, that say it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const { access } = g;
  const userId = access.session.user.id;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length >= 2) {
    return NextResponse.json({ hits: await inClinic(access, (c) => searchMessages(c, access.clinicId, q)) });
  }
  if (new URL(req.url).searchParams.has("count")) {
    return NextResponse.json({ unread: await inClinic(access, (c) => teamUnread(c, access.clinicId, userId)) });
  }
  const data = await inClinic(access, async (c) => ({
    threads: await loadThreads(c, access.clinicId, userId),
    people: await loadTeamPeople(c, access.clinicId),
  }));
  return NextResponse.json(data);
}

const start = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), userId: z.string().uuid() }),
  z.object({ kind: z.literal("group"), name: z.string().trim().min(1).max(60), userIds: z.array(z.string().uuid()).min(1).max(100) }),
]);

/** A private thread with one colleague (the existing one if there is one), or a new group. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const parsed = start.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;
  const id = await inClinic(g.access, async (c) => {
    const r =
      d.kind === "direct"
        ? await c.query(`select app_team_open_direct($1) as id`, [d.userId])
        : await c.query(`select app_team_create_group($1, $2::uuid[]) as id`, [d.name, d.userIds]);
    return (r.rows[0]?.id as string) ?? null;
  });
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });
  return NextResponse.json({ id });
}
