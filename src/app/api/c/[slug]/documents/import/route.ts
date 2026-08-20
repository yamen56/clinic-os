import { NextResponse } from "next/server";
import { apiClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { docxToHtml, pdfToHtml, sniffFormat } from "@/lib/esign/import";

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Reads a Word or PDF file the clinic already uses and hands back an editable
 * body for the template editor.
 *
 * Nothing is written here. The caller previews what came out, edits it, and
 * saves it as a template the ordinary way — because an import can come back
 * wrong (see lib/esign/import for why, especially for Arabic PDFs) and creating
 * a template first would leave a bad one behind whenever the clinic looked at
 * the result and decided to keep using the upload instead.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const auth = await apiClinic(slug, "documents.manage");
  if (!auth.ok) return auth.res;
  if (!can(auth.access, "settings")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const data = Buffer.from(await file.arrayBuffer());
  const format = sniffFormat(data);
  if (format === "unknown") {
    // The old binary .doc is the common case here and is worth naming: it is a
    // different format entirely, and Word converts it in one Save As.
    return NextResponse.json({ error: "unsupported_format" }, { status: 415 });
  }

  try {
    const result = format === "docx" ? await docxToHtml(data) : await pdfToHtml(data);
    return NextResponse.json({ format, ...result });
  } catch (e) {
    // Logged, not swallowed: "that file could not be read" is the right thing to
    // tell the clinic and the wrong thing to be left holding when it turns out
    // the reason was a missing font table rather than their file.
    console.error("[document import]", format, (e as Error).message);
    return NextResponse.json({ error: "unreadable_file" }, { status: 415 });
  }
}
