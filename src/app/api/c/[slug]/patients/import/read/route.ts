import { NextResponse } from "next/server";
import { apiClinic } from "@/lib/clinic-api";
import { decodeUpload } from "@/lib/import/parse";
import { looksLikeXlsx, xlsxToDelimited } from "@/lib/import/sheet";

/**
 * Turns an uploaded spreadsheet into the delimited text the importer reads.
 *
 * Only for files the browser cannot decode on its own — an `.xlsx`, which is a
 * zip of XML rather than text. A CSV never reaches here: the import screen
 * decodes those locally, so the bytes stay on the operator's machine until they
 * have seen the preview.
 *
 * Nothing is written down. The file is parsed in memory and the rows come back
 * in the response; there is no upload directory, no row in a table, and no trace
 * of a list that somebody thought better of importing.
 *
 * The format is decided by the bytes rather than the extension — a file named
 * `.xlsx` that is really a CSV is common enough (someone renamed it hoping to
 * make it work), and both are handled the same way whichever it turns out to be.
 */

/** Bigger than any plausible patient list, small enough to hold in memory. */
const MAX_BYTES = 12 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  // The same capability the importer itself needs: this route exists only to
  // feed it, and a door beside a locked door is not a lock.
  const g = await apiClinic(slug, "patients.import");
  if (!g.ok) return g.res;

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "bad_form" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "too_big", max: MAX_BYTES }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const text = looksLikeXlsx(new Uint8Array(buf))
      ? await xlsxToDelimited(buf)
      : decodeUpload(buf);
    if (!text.trim()) return NextResponse.json({ error: "empty" }, { status: 422 });
    return NextResponse.json({ text }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[import read]", (e as Error).message);
    return NextResponse.json({ error: "unreadable" }, { status: 422 });
  }
}
