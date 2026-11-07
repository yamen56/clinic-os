import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { byteRange, fileResponseHeaders } from "@/lib/download";
import { apiTeam } from "@/lib/team-chat";

export const dynamic = "force-dynamic";

/**
 * A message's file, for the people in its thread and nobody else: the row is read
 * under row security, so anybody else gets a 404 as if it never existed.
 *
 * Not cached: a computer at the desk is shared, and the next person at it is not
 * necessarily in the conversation. Byte ranges, because Safari on an iPhone will
 * not play a voice note served without them.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; messageId: string }> }) {
  const { slug, messageId } = await ctx.params;
  if (!isUuid(messageId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(`select file_path, file_name, file_mime from team_messages where id = $1 and deleted_at is null`, [messageId]);
    return r.rows[0] ?? null;
  });
  if (!meta?.file_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = await openFile(meta.file_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  const headers = {
    ...fileResponseHeaders({ declaredType: meta.file_mime, fileName: meta.file_name ?? "file", size: f.size, cacheControl: "private, no-store" }),
    "Accept-Ranges": "bytes",
  };
  const range = byteRange(req.headers.get("range"), f.size);
  if (range === "unsatisfiable") return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${f.size}` } });
  if (range) {
    const [start, end] = range;
    return new NextResponse(new Uint8Array(f.data.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${f.size}` },
    });
  }
  return new NextResponse(new Uint8Array(f.data), { headers });
}

/** The sender takes a message back: it becomes "message deleted" for everybody, and its file goes. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string; messageId: string }> }) {
  const { slug, messageId } = await ctx.params;
  if (!isUuid(messageId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const n = await inClinic(g.access, async (c) => {
    const r = await c.query(`update team_messages set deleted_at = now() where id = $1 and sender_id = $2 and deleted_at is null`, [messageId, g.access.session.user.id]);
    return r.rowCount ?? 0;
  });
  if (!n) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
