import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { Readable } from "node:stream";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;

  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select storage_path, file_name, mime_type from patient_files where id = $1 and clinic_id = $2`,
      [fileId, g.access.clinicId]
    );
    return r.rows[0] ?? null;
  });
  if (!meta) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const f = openFile(meta.storage_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  const download = new URL(req.url).searchParams.has("download");
  return new NextResponse(Readable.toWeb(f.stream) as ReadableStream, {
    headers: {
      "Content-Type": meta.mime_type,
      "Content-Length": String(f.size),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(meta.file_name)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
