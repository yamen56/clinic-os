import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { fileResponseHeaders } from "@/lib/download";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; messageId: string }> }
) {
  const { slug, messageId } = await ctx.params;
  const g = await apiClinic(slug, "conversations");
  if (!g.ok) return g.res;

  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select media_path, media_mime, media_name from messages where id = $1 and clinic_id = $2`,
      [messageId, g.access.clinicId]
    );
    return r.rows[0] ?? null;
  });
  if (!meta?.media_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = await openFile(meta.media_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  /*
    The most hostile of these routes: `media_mime` is whatever the sender's
    WhatsApp client declared, and anyone who can message the clinic's number can
    set it. It is a hint here and nothing more — see lib/download.
  */
  return new NextResponse(new Uint8Array(f.data), {
    headers: fileResponseHeaders({
      declaredType: meta.media_mime,
      fileName: meta.media_name ?? "media",
      size: f.size,
      cacheControl: "private, max-age=86400",
    }),
  });
}
