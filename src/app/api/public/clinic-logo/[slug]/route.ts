import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { openFile } from "@/lib/storage";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const clinic = await withSystem(async (c) => {
    const r = await c.query(`select logo_path from clinics where slug = $1`, [slug]);
    return r.rows[0] ?? null;
  });
  if (!clinic?.logo_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = await openFile(clinic.logo_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });
  return new NextResponse(new Uint8Array(f.data), {
    headers: {
      "Content-Type": clinic.logo_path.endsWith(".png") ? "image/png" : "image/jpeg",
      "Content-Length": String(f.size),
      "Cache-Control": "public, max-age=300",
    },
  });
}
