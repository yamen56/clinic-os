import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { readFileBuffer } from "@/lib/storage";
import { logDocEvent, requestIp, requestUserAgent } from "@/lib/esign/events";
import { generateFinalPdf } from "@/lib/esign/pdf";

/**
 * The finished PDF, for staff.
 *
 * Served through the app rather than by a permanent link: a signed consent form
 * must never be reachable by anyone who happens to have a URL. Every download is
 * an audit event, because "who took a copy of this" is part of what makes the
 * record defensible.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const auth = await apiClinic(slug, "documents");
  if (!auth.ok) return auth.res;
  const { access } = auth;

  const doc = await inClinic(access, async (c) => {
    const r = await c.query(
      `select id, title, status, final_pdf_path from documents where id = $1 and clinic_id = $2`,
      [id, access.clinicId]
    );
    return r.rows[0] as
      | { id: string; title: string; status: string; final_pdf_path: string | null }
      | undefined;
  });
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let path = doc.final_pdf_path;
  // A completed document whose render failed or was never queued is generated on
  // demand rather than handing staff a dead button.
  if (!path && (doc.status === "completed" || doc.status === "voided")) {
    const built = await generateFinalPdf(id);
    if ("error" in built) {
      return NextResponse.json({ error: "pdf_failed", detail: built.error }, { status: 503 });
    }
    path = built.path;
  }
  if (!path) return NextResponse.json({ error: "not_ready" }, { status: 409 });

  const data = await readFileBuffer(path);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await inClinic(access, (c) =>
    logDocEvent(c, {
      clinicId: access.clinicId,
      documentId: id,
      type: "downloaded",
      actorUserId: access.session.user.id,
      actorKind: "staff",
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    })
  );

  const filename = `${doc.title.replace(/[^\w؀-ۿ .-]+/g, "_").slice(0, 60) || "document"}.pdf`;
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(data.length),
      // RFC 5987 form as well, so an Arabic title survives the download dialog.
      "Content-Disposition": `inline; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
