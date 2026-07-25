import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { openFile } from "@/lib/storage";
import { Readable } from "node:stream";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const clinic = await withSystem(async (c) => {
    const r = await c.query(`select logo_path from clinics where slug = $1`, [slug]);
    return r.rows[0] ?? null;
  });
  if (!clinic?.logo_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = openFile(clinic.logo_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });
  return new NextResponse(Readable.toWeb(f.stream) as ReadableStream, {
    headers: {
      "Content-Type": clinic.logo_path.endsWith(".png") ? "image/png" : "image/jpeg",
      "Content-Length": String(f.size),
      "Cache-Control": "public, max-age=300",
    },
  });
}
