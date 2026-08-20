import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { readFileBuffer } from "@/lib/storage";

/**
 * Serves an uploaded template's PDF back to the placement editor.
 *
 * The path arrives from the client, so it is not trusted: it has to be a path
 * this clinic actually recorded on one of its own templates. Checking the
 * database rather than the string is what stops a caller reading another
 * clinic's file by editing a query parameter.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const auth = await apiClinic(slug, "documents");
  if (!auth.ok) return auth.res;
  const { access } = auth;

  const path = new URL(req.url).searchParams.get("path");
  if (!path) return NextResponse.json({ error: "missing_path" }, { status: 400 });

  const owned = await inClinic(access, async (c) => {
    const r = await c.query(
      `select 1 from document_templates where clinic_id = $1 and source_pdf_path = $2
       union all
       select 1 from documents where clinic_id = $1 and source_pdf_path = $2
       limit 1`,
      [access.clinicId, path]
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const data = await readFileBuffer(path);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
    },
  });
}
