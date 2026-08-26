import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { fileResponseHeaders } from "@/lib/download";

/**
 * Plays back a voice note.
 *
 * Served through the app rather than from a storage URL, for the same reason
 * every other patient file is: the object store is private, and membership of
 * this clinic is what decides whether these seconds of a consultation may be
 * heard. The path is looked up from the note, never taken from the caller.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; noteId: string }> }) {
  const { slug, noteId } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;

  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select audio_path, audio_mime from patient_notes
       where id = $1 and clinic_id = $2 and audio_path is not null`,
      [noteId, g.access.clinicId]
    );
    return r.rows[0] ?? null;
  });
  if (!meta) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const f = await openFile(meta.audio_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  return new NextResponse(new Uint8Array(f.data), {
    headers: fileResponseHeaders({
      declaredType: meta.audio_mime ?? "audio/webm",
      fileName: `voice-note.${(meta.audio_mime ?? "audio/webm").split("/")[1]?.split(";")[0] ?? "webm"}`,
      size: f.size,
      wantsDownload: new URL(req.url).searchParams.has("download"),
    }),
  });
}
