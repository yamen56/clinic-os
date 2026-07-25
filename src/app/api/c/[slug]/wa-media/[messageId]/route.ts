import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { Readable } from "node:stream";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; messageId: string }> }
) {
  const { slug, messageId } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;

  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select media_path, media_mime, media_name from messages where id = $1 and clinic_id = $2`,
      [messageId, g.access.clinicId]
    );
    return r.rows[0] ?? null;
  });
  if (!meta?.media_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = openFile(meta.media_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });
  return new NextResponse(Readable.toWeb(f.stream) as ReadableStream, {
    headers: {
      "Content-Type": meta.media_mime ?? "application/octet-stream",
      "Content-Length": String(f.size),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.media_name ?? "media")}`,
      "Cache-Control": "private, max-age=86400",
    },
  });
}
