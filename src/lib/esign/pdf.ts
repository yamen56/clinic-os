import { withSystem } from "../db";
import { renderUrlToPdf, renderOverlays } from "../pdf";
import { readFileBuffer, saveFile } from "../storage";
import { appUrl } from "../urls";
import { printUrl } from "./print-token";
import { logDocEvent } from "./events";

/**
 * Producing the finished PDF.
 *
 * Two paths, and the difference matters:
 *
 *  - A template document *is* an HTML page, so headless Chromium prints it
 *    directly. That is the only way Arabic comes out shaped, joined and flowing
 *    right-to-left. pdf-lib and react-pdf both write glyphs in logical order
 *    with no shaping engine, which produces reversed, disconnected text.
 *  - An uploaded document must not be re-typeset — the clinic's own file is the
 *    agreement. pdf-lib only composites: transparent layers carrying the
 *    signatures and values (rendered by that same Chromium) go over the
 *    untouched pages, and the certificate is appended as extra pages.
 *
 * Either way the Certificate of Completion is the final page, always.
 */

export type PdfResult = { path: string; bytes: number } | { error: string };

export async function generateFinalPdf(documentId: string): Promise<PdfResult> {
  const doc = await withSystem(async (c) => {
    const r = await c.query(
      `select id, clinic_id, source, title, status, source_pdf_path, content_hash
       from documents where id = $1`,
      [documentId]
    );
    return r.rows[0] as
      | {
          id: string;
          clinic_id: string;
          source: "template" | "upload";
          title: string;
          status: string;
          source_pdf_path: string | null;
          content_hash: string | null;
        }
      | undefined;
  });
  if (!doc) return { error: "not_found" };

  const base = appUrl();
  let pdf: Buffer;

  try {
    if (doc.source === "upload") {
      pdf = await buildStampedPdf(doc.id, doc.source_pdf_path, base);
    } else {
      pdf = await renderUrlToPdf(printUrl(base, doc.id, "document"));
    }
    pdf = await tagMetadata(pdf, doc);
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }

  const safeTitle = doc.title.replace(/[^\w؀-ۿ .-]+/g, "_").slice(0, 60) || "document";
  const saved = await saveFile(doc.clinic_id, "documents", `${safeTitle}.pdf`, pdf);

  await withSystem(async (c) => {
    await c.query(`update documents set final_pdf_path = $2 where id = $1`, [
      documentId,
      saved.storagePath,
    ]);
    await logDocEvent(c, {
      clinicId: doc.clinic_id,
      documentId,
      type: "completed",
      actorKind: "system",
      metadata: { pdf: saved.storagePath, bytes: saved.sizeBytes },
    });
  });

  return { path: saved.storagePath, bytes: saved.sizeBytes };
}

/**
 * Writes the document's identity into the PDF's own metadata.
 *
 * Worth doing because the body text of these files is not searchable in Arabic.
 * Chromium shapes Arabic correctly — which is exactly why the glyphs it embeds
 * are presentation forms in visual order, so extracting the text back out yields
 * something a search will not match. The rendering is right; the text layer is
 * lossy, and that is a property of every browser-printed Arabic PDF.
 *
 * Two things follow. The authoritative machine-readable copy of what was signed
 * is `documents.content_snapshot`, which the hash covers — not the PDF. And the
 * PDF at least carries its title, its patient and its fingerprint as metadata, so
 * a folder of thousands of them stays identifiable and searchable by the fields
 * that matter for retrieval.
 */
async function tagMetadata(
  pdf: Buffer,
  doc: { id: string; title: string; content_hash: string | null }
): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const d = await PDFDocument.load(pdf, { ignoreEncryption: true });
  d.setTitle(doc.title);
  d.setSubject(`Signed document ${doc.id}`);
  d.setKeywords([doc.id, doc.content_hash ?? ""].filter(Boolean));
  d.setProducer("Clinicti");
  d.setCreator("Clinicti");
  return Buffer.from(await d.save());
}

/**
 * The uploaded path: original pages, untouched, with the drawn values
 * composited on top, then the certificate appended.
 */
async function buildStampedPdf(
  documentId: string,
  sourcePath: string | null,
  base: string
): Promise<Buffer> {
  if (!sourcePath) throw new Error("uploaded document has no source file");
  const original = await readFileBuffer(sourcePath);
  if (!original) throw new Error("uploaded document file is missing from storage");

  const { PDFDocument } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.load(original, { ignoreEncryption: true });

  const overlays = await renderOverlays(printUrl(base, documentId, "overlay"));
  const pages = pdfDoc.getPages();
  for (let i = 0; i < overlays.length && i < pages.length; i++) {
    const layer = overlays[i];
    if (!layer?.length) continue;
    const png = await pdfDoc.embedPng(layer);
    const page = pages[i];
    const { width, height } = page.getSize();
    // The layer was rendered at the page's aspect ratio, so it maps corner to
    // corner — the placed boxes were stored as fractions for exactly this.
    page.drawImage(png, { x: 0, y: 0, width, height });
  }

  const certificate = await renderUrlToPdf(printUrl(base, documentId, "certificate"));
  const certDoc = await PDFDocument.load(certificate);
  const certPages = await pdfDoc.copyPages(certDoc, certDoc.getPageIndices());
  for (const p of certPages) pdfDoc.addPage(p);

  return Buffer.from(await pdfDoc.save());
}

/** Page count of an uploaded PDF, so the field placer knows what it is working with. */
export async function pdfPageCount(data: Buffer): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  const d = await PDFDocument.load(data, { ignoreEncryption: true });
  return d.getPageCount();
}

/** Page aspect ratios (width/height), so placed boxes keep their proportions on screen. */
export async function pdfPageSizes(data: Buffer): Promise<{ width: number; height: number }[]> {
  const { PDFDocument } = await import("pdf-lib");
  const d = await PDFDocument.load(data, { ignoreEncryption: true });
  return d.getPages().map((p) => p.getSize());
}
