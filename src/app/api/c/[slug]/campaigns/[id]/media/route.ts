import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { fileResponseHeaders } from "@/lib/download";

/**
 * The photo or video a campaign carries, for its detail page.
 *
 * Answers byte ranges because Safari will not play a <video> from a server that
 * does not — it asks for the first two bytes, and a full 200 in reply reads as
 * a broken file. Clinic staff on iPads are on Safari. The whole file is still
 * read from storage per request; at sixteen megabytes and a page few people
 * open, that is cheaper than threading ranges through both storage drivers.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "campaigns");
  if (!g.ok) return g.res;

  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select media_path, media_mime, media_name from campaigns where id = $1 and clinic_id = $2`,
      [id, g.access.clinicId]
    );
    return r.rows[0] ?? null;
  });
  if (!meta?.media_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = await openFile(meta.media_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  const headers = {
    ...fileResponseHeaders({
      declaredType: meta.media_mime,
      fileName: meta.media_name ?? "media",
      size: f.size,
      cacheControl: "private, max-age=86400",
    }),
    "Accept-Ranges": "bytes",
  };

  const range = byteRange(req.headers.get("range"), f.size);
  if (range === "unsatisfiable") {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${f.size}` } });
  }
  if (range) {
    const [start, end] = range;
    return new NextResponse(new Uint8Array(f.data.subarray(start, end + 1)), {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${f.size}`,
      },
    });
  }
  return new NextResponse(new Uint8Array(f.data), { headers });
}

/**
 * One `bytes=` range, inclusive. Null means serve the whole file — no header,
 * or a multi-range request, which no media element sends and a full 200
 * answers correctly anyway.
 */
function byteRange(header: string | null, size: number): [number, number] | "unsatisfiable" | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // `bytes=-500`: the last five hundred.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "unsatisfiable";
  return [start, end];
}
