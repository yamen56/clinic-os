import { NextResponse } from "next/server";
import { apiClinic } from "@/lib/clinic-api";
import { openFileStream } from "@/lib/storage";
import { BRIDGE_STORAGE_PATH, BRIDGE_VERSION } from "@/lib/imaging/bridge-version";

/*
  The Clinicti Bridge installer, for the doctor setting up a machine.
  Streamed from storage — it is ~80 MB, and reading it whole into memory for
  every download would be a cost paid for nothing. Published there by
  scripts/publish-bridge.ts whenever BRIDGE_VERSION changes.
*/
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "settings.clinic");
  if (!g.ok) return g.res;
  const f = await openFileStream(BRIDGE_STORAGE_PATH);
  if (!f) return NextResponse.json({ error: "bridge_not_published" }, { status: 404 });
  return new NextResponse(f.stream, {
    headers: {
      "Content-Type": "application/vnd.microsoft.portable-executable",
      "Content-Disposition": `attachment; filename="ClinictiBridge-${BRIDGE_VERSION}.exe"`,
      ...(f.size ? { "Content-Length": String(f.size) } : {}),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
