import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { sanitizeHtml } from "./render";

/**
 * Turning a file the clinic already has into an editable template body.
 *
 * The two formats are not equally convertible and the UI should not pretend
 * otherwise:
 *
 *   .docx — a real conversion. The file is a zip of XML with the structure
 *           intact: headings are headings, lists are lists, bold is bold. What
 *           comes out is close to what went in and is genuinely editable.
 *
 *   .pdf  — an extraction, not a conversion. A PDF stores positioned glyphs,
 *           not paragraphs; there is no such thing as "the heading" in the file.
 *           Text can be recovered and re-flowed, but the layout cannot, and for
 *           Arabic even the text is unreliable — a PDF printed by a browser
 *           embeds presentation forms in visual order, so what is extracted can
 *           come back reversed and disconnected. That is a property of the file,
 *           not of this code, which is why the caller is handed a warning and
 *           the original is always kept.
 *
 * Output is sanitised with the same allowlist the template editor and the
 * renderer use, so an imported body cannot carry anything a hand-typed one
 * could not.
 */

export type ImportResult = {
  html: string;
  /** Anything the clinic should check before trusting the result. */
  warnings: string[];
  /** Rough guide for the editor: an empty body means extraction found nothing. */
  characters: number;
};

/** Word. `mammoth` maps document structure to HTML; it does not run macros or scripts. */
export async function docxToHtml(data: Buffer): Promise<ImportResult> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml(
    { buffer: data },
    {
      // Word writes visual formatting; these map the semantic bits we keep.
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
      ],
      /*
        Images come through as bare tags with no source, which the sanitiser
        then drops entirely — `img` is not in its allowlist, so they could never
        survive anyway. Doing it here means mammoth never builds the base64 in
        the first place: a letterhead inlined into every template would turn a
        4 KB row into a 400 KB one for nothing. The clinic's logo belongs in the
        clinic profile, where it is set once and printed on everything.
      */
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    }
  );

  const html = sanitizeHtml(result.value ?? "");
  const warnings: string[] = [];
  if (result.messages?.some((m) => m.type === "warning")) warnings.push("docx_partial");
  if (/<img/i.test(result.value ?? "")) warnings.push("images_dropped");
  return { html, warnings, characters: textLength(html) };
}

/**
 * PDF. Text is pulled out page by page and re-flowed into paragraphs, using the
 * vertical gap between lines to guess where one ends.
 */
export async function pdfToHtml(data: Buffer): Promise<ImportResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    // No worker fetch and no system fonts: this runs server-side purely to read
    // the text layer, and never paints a page.
    useWorkerFetch: false,
    useSystemFonts: false,
    // pdf.js maps glyphs back to characters through the standard font metrics.
    // Without them a PDF that uses Helvetica or Times — which is most of them —
    // extracts as nothing at all.
    standardFontDataUrl: standardFontsDir(),
  });
  const doc = await task.promise;

  const blocks: string[] = [];
  let arabic = false;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    let line = "";
    let lastY: number | null = null;
    const flush = () => {
      const text = line.replace(/\s+/g, " ").trim();
      if (text) blocks.push(text);
      line = "";
    };

    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      const str = item.str ?? "";
      if (!str) continue;
      if (/[؀-ۿﭐ-﷿ﹰ-﻿]/.test(str)) arabic = true;
      const y = item.transform?.[5] ?? null;
      // A vertical jump of more than a couple of points is a new line; a big one
      // is a new paragraph. Same line, so just append.
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        if (Math.abs(y - lastY) > 14) flush();
        else line += " ";
      }
      line += str;
      if (y !== null) lastY = y;
    }
    flush();
  }
  await task.destroy();

  const html = sanitizeHtml(
    blocks.map((b) => `<p>${escapeHtml(b)}</p>`).join("\n")
  );

  const warnings = ["pdf_layout_lost"];
  if (arabic) warnings.push("pdf_arabic");
  if (blocks.length === 0) warnings.push("pdf_no_text");
  return { html, warnings, characters: textLength(html) };
}

/**
 * Where pdf.js keeps its standard font metrics, resolved from the installed
 * package rather than hard-coded, so it survives a hoisted or nested
 * `node_modules` layout. Returns undefined if it cannot be found — extraction
 * still runs, it is just poorer, which beats throwing.
 */
function standardFontsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("pdfjs-dist/package.json");
    return pathToFileURL(path.join(path.dirname(pkg), "standard_fonts") + path.sep).href;
  } catch {
    return undefined;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().length;
}

/** Sniffs the format from the bytes, so a wrong extension does not decide it. */
export function sniffFormat(data: Buffer): "pdf" | "docx" | "unknown" {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  // Every .docx is a zip; the old binary .doc is not and cannot be read here.
  if (data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05)) return "docx";
  return "unknown";
}
