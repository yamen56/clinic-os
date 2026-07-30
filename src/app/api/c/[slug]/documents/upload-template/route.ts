import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { saveFile } from "@/lib/storage";
import { pdfPageCount } from "@/lib/esign/pdf";

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Accepts a PDF the clinic already uses and stores it as a template's source.
 *
 * The file is validated by its own header rather than by the browser's declared
 * MIME type, and the page count is read here so the placement editor knows how
 * many pages it is working with before it renders any of them.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const auth = await apiClinic(slug);
  if (!auth.ok) return auth.res;
  const { access } = auth;
  if (access.role === "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const data = Buffer.from(await file.arrayBuffer());
  // %PDF- — trust the bytes, not the Content-Type the browser attached.
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return NextResponse.json({ error: "not_pdf" }, { status: 415 });
  }

  let pages: number;
  try {
    pages = await pdfPageCount(data);
  } catch {
    return NextResponse.json({ error: "unreadable_pdf" }, { status: 415 });
  }

  const saved = await saveFile(access.clinicId, "document-templates", file.name || "template.pdf", data);

  const templateId = form?.get("templateId");
  if (typeof templateId === "string" && templateId) {
    await inClinic(access, (c) =>
      c.query(
        `update document_templates set source = 'upload', source_pdf_path = $3
         where id = $1 and clinic_id = $2`,
        [templateId, access.clinicId, saved.storagePath]
      )
    );
  }

  return NextResponse.json({ path: saved.storagePath, pages, bytes: saved.sizeBytes });
}
