import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withSystem } from "@/lib/db";

const PAGE = 30;

/**
 * A timestamp from the query string, or null for anything that is not one.
 * Passed on as written rather than through `Date`, which would drop the
 * microseconds a `cursor` carries.
 */
function when(v: string | null): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  return Number.isNaN(new Date(v).getTime()) ? null : v;
}

/**
 * The signed-in person's notifications.
 *
 *   ?count          just the unread number — the header badge asks this on
 *                   every change, so it is one indexed count and nothing else;
 *   ?since=<iso>    what arrived after a moment, for the in-app pop-up;
 *   ?before=<iso>   the next page of the list, older than the last one shown;
 *   ?unread         only what has not been read.
 */
export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const q = new URL(req.url).searchParams;

  const countUnread = (c: import("pg").PoolClient) =>
    c
      .query(`select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [s.user.id])
      .then((r) => r.rows[0].n as number);

  if (q.has("count")) {
    const unread = await withSystem(countUnread);
    return NextResponse.json({ unread });
  }

  const since = when(q.get("since"));
  const before = when(q.get("before"));
  const unreadOnly = q.has("unread");
  const limit = since ? 5 : PAGE;

  const data = await withSystem(async (c) => {
    const rows = (
      await c.query(
        /*
          `cursor` is the timestamp at the database's own precision. A JS Date
          keeps milliseconds and Postgres keeps microseconds, so paging or
          polling with `created_at` itself would ask for "after .068" and get
          the row written at .068500 back again — a pop-up shown twice.
        */
        `select n.id, n.kind, n.title, n.body, n.url, n.read_at, n.created_at, cl.name as clinic_name,
                to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor
           from notifications n left join clinics cl on cl.id = n.clinic_id
          where n.user_id = $1
            and ($2::timestamptz is null or n.created_at > $2)
            and ($3::timestamptz is null or n.created_at < $3)
            and (not $4 or n.read_at is null)
          order by n.created_at desc limit $5`,
        [s.user.id, since, before, unreadOnly || !!since, limit + 1]
      )
    ).rows;
    return { rows, unread: await countUnread(c) };
  });
  return NextResponse.json({
    notifications: data.rows.slice(0, limit),
    more: data.rows.length > limit,
    unread: data.unread,
  });
}

/** Mark one notification read, or all of them. */
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id, all } = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean };
  if (!all && (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
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
