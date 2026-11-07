import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { byteRange, fileResponseHeaders } from "@/lib/download";
import { z } from "zod";
import sharp from "sharp";
import { EDIT_MINUTES, apiTeam } from "@/lib/team-chat";

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

  // A small copy of a photo, for the picture on a phone's notification.
  if (new URL(req.url).searchParams.has("thumb") && (meta.file_mime ?? "").startsWith("image/")) {
    try {
      const small = await sharp(f.data).rotate().resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      return new NextResponse(new Uint8Array(small), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    } catch {
      return NextResponse.json({ error: "bad_image" }, { status: 415 });
    }
  }

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

/** The sender takes a message back: it becomes "message deleted" for everybody, and its file goes. A pinned one is unpinned. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string; messageId: string }> }) {
  const { slug, messageId } = await ctx.params;
  if (!isUuid(messageId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const n = await inClinic(g.access, async (c) => {
    const r = await c.query(`update team_messages set deleted_at = now() where id = $1 and sender_id = $2 and deleted_at is null returning thread_id`, [messageId, g.access.session.user.id]);
    if (r.rowCount) await c.query(`update team_threads set pinned_message_id = null, pinned_by = null where id = $1 and pinned_message_id = $2`, [r.rows[0].thread_id, messageId]);
    return r.rowCount ?? 0;
  });
  if (!n) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

const change = z.discriminatedUnion("op", [
  z.object({ op: z.literal("edit"), body: z.string().max(4000) }),
  z.object({ op: z.literal("react"), emoji: z.string().min(1).max(16).nullable() }),
  z.object({ op: z.literal("pin"), pinned: z.boolean() }),
]);

/**
 * What can happen to a sent message.
 *
 *   edit   the sender's own words, within EDIT_MINUTES of sending, and only words:
 *          a file stays as sent. It says "edited", and nobody is told again.
 *   react  anybody in the thread: one emoji each, replaced by the next; null takes
 *          it back. The sender hears of it (app_team_react).
 *   pin    anybody in the thread pins it at the top for everybody, or unpins it.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; messageId: string }> }) {
  const { slug, messageId } = await ctx.params;
  if (!isUuid(messageId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const parsed = change.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;
  const userId = g.access.session.user.id;

  const result = await inClinic(g.access, async (c) => {
    const m = (await c.query(`select id, thread_id, sender_id, body, file_path, created_at, deleted_at from team_messages where id = $1`, [messageId])).rows[0];
    if (!m || m.deleted_at) return "not_found";
    if (d.op === "edit") {
      if (m.sender_id !== userId) return "not_found";
      if (Date.now() - new Date(m.created_at).getTime() > EDIT_MINUTES * 60_000) return "too_late";
      if (!d.body.trim() && !m.file_path) return "invalid";
      if (d.body === m.body) return "ok";
      await c.query(`update team_messages set body = $2, edited_at = now() where id = $1`, [messageId, d.body]);
      return "ok";
    }
    if (d.op === "react") {
      const ok = (await c.query(`select app_team_react($1, $2) as ok`, [messageId, d.emoji])).rows[0].ok;
      return ok ? "ok" : "not_found";
    }
    await c.query(
      d.pinned
        ? `update team_threads set pinned_message_id = $2, pinned_by = $3 where id = $1`
        : `update team_threads set pinned_message_id = null, pinned_by = null where id = $1 and pinned_message_id = $2`,
      d.pinned ? [m.thread_id, messageId, userId] : [m.thread_id, messageId]
    );
    return "ok";
  });
  if (result !== "ok") return NextResponse.json({ error: result }, { status: result === "not_found" ? 404 : result === "too_late" ? 409 : 400 });
  return NextResponse.json({ ok: true });
}
