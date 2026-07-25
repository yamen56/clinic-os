import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withSystem } from "@/lib/db";

/** Register this device for web push. */
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await withSystem((c) =>
    c.query(
      `insert into push_subscriptions (user_id, endpoint, keys, user_agent)
       values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = excluded.user_id, keys = excluded.keys`,
      [s.user.id, body.endpoint, JSON.stringify(body.keys), req.headers.get("user-agent") ?? null]
    )
  );
  return NextResponse.json({ ok: true });
}

/** Unregister this device. */
export async function DELETE(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (!endpoint) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await withSystem((c) =>
    c.query(`delete from push_subscriptions where endpoint = $1 and user_id = $2`, [endpoint, s.user.id])
  );
  return NextResponse.json({ ok: true });
}
