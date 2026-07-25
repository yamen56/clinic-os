import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withSystem } from "@/lib/db";

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ ok: false }, { status: 400 });
  await withSystem((c) =>
    c.query(
      `update users set settings = jsonb_set(settings, '{dismissedAnnouncements}',
         coalesce(settings->'dismissedAnnouncements', '[]'::jsonb) || to_jsonb($2::text))
       where id = $1 and not (coalesce(settings->'dismissedAnnouncements', '[]'::jsonb) ? $2)`,
      [s.user.id, id]
    )
  );
  return NextResponse.json({ ok: true });
}
