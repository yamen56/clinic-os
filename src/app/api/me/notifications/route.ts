import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withSystem } from "@/lib/db";

export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const unreadOnly = new URL(req.url).searchParams.has("unread");

  const data = await withSystem(async (c) => {
    const rows = (
      await c.query(
        `select n.id, n.kind, n.title, n.body, n.url, n.read_at, n.created_at, cl.name as clinic_name
         from notifications n left join clinics cl on cl.id = n.clinic_id
         where n.user_id = $1 ${unreadOnly ? "and n.read_at is null" : ""}
         order by n.created_at desc limit 60`,
        [s.user.id]
      )
    ).rows;
    const unread = (
      await c.query(
        `select count(*)::int as n from notifications where user_id = $1 and read_at is null`,
        [s.user.id]
      )
    ).rows[0].n;
    return { rows, unread };
  });
  return NextResponse.json({ notifications: data.rows, unread: data.unread });
}

/** Mark one notification read, or all of them. */
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id, all } = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean };
  await withSystem((c) =>
    all
      ? c.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [
          s.user.id,
        ])
      : c.query(
          `update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null`,
          [id, s.user.id]
        )
  );
  return NextResponse.json({ ok: true });
}
