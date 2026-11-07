import path from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { saveFile } from "@/lib/storage";
import { MAX_FILE, apiTeam, loadMessages } from "@/lib/team-chat";

export const dynamic = "force-dynamic";

/**
 * A message into a thread: words, a file, or both. A JSON body for words alone,
 * multipart when something is attached.
 *
 * A photo is turned the right way up and saved again without its metadata. A
 * phone's photo carries where it was taken, and a picture of a patient's chart
 * sent to a colleague has no business carrying the clinic's coordinates, or a
 * doctor's home's.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; threadId: string }> }) {
  const { slug, threadId } = await ctx.params;
  if (!isUuid(threadId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiTeam(slug);
  if (!g.ok) return g.res;
  const { access } = g;

  let id: string | null = null;
  let body = "";
  let file: { buf: Buffer; name: string; mime: string; seconds: number | null } | null = null;
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    body = String(form.get("body") ?? "");
    id = String(form.get("id") ?? "") || null;
    const f = form.get("file");
    if (f instanceof File && f.size > 0) {
      if (f.size > MAX_FILE) return NextResponse.json({ error: "too_large" }, { status: 413 });
      const seconds = Number(form.get("seconds"));
      file = {
        buf: Buffer.from(await f.arrayBuffer()),
        name: (f.name || "file").slice(0, 200),
        mime: f.type || "application/octet-stream",
        seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : null,
      };
    }
  } else {
    const j = (await req.json().catch(() => ({}))) as { body?: string; id?: string };
    body = String(j.body ?? "");
    id = j.id ?? null;
  }
  body = body.slice(0, 4000);
  if (!body.trim() && !file) return NextResponse.json({ error: "empty" }, { status: 400 });
  // The browser names the message, so a retry after a dropped answer is the same message, not two.
  if (id && !isUuid(id)) return NextResponse.json({ error: "invalid" }, { status: 400 });

  if (file && file.mime.startsWith("image/") && file.mime !== "image/gif") {
    try {
      file.buf = await sharp(file.buf).rotate().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
      file.mime = "image/jpeg";
      file.name = `${path.parse(file.name).name || "photo"}.jpg`;
    } catch {
      return NextResponse.json({ error: "bad_image" }, { status: 400 });
    }
  }

  const result = await inClinic(access, async (c) => {
    const t = (await c.query(`select id from team_threads where id = $1`, [threadId])).rows[0];
    if (!t) return null;
    if (id && (await c.query(`select 1 from team_messages where id = $1`, [id])).rowCount) {
      return (await loadMessages(c, threadId, null)).find((m) => m.id === id) ?? null;
    }
    const saved = file ? await saveFile(access.clinicId, "team-media", file.name, file.buf) : null;
    const row = (
      await c.query(
        `insert into team_messages (id, clinic_id, thread_id, sender_id, body, file_path, file_name, file_mime, file_size, file_seconds)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [id, access.clinicId, threadId, access.session.user.id, body, saved?.storagePath ?? null, file?.name ?? null, file?.mime ?? null, saved?.sizeBytes ?? null, file?.seconds ?? null]
      )
    ).rows[0];
    await c.query(`select app_team_notify($1)`, [row.id]);
    await c.query(`update team_thread_members set unread = 0, last_read_at = now() where thread_id = $1 and user_id = $2`, [threadId, access.session.user.id]);
    return (await loadMessages(c, threadId, null)).find((m) => m.id === row.id) ?? null;
  });
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ message: result });
}
