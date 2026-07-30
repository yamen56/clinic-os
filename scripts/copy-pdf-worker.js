/**
 * Puts pdf.js's worker where the browser can fetch it.
 *
 * pdf.js parses PDFs in a real Web Worker, which has to be a file served over
 * HTTP — it cannot be bundled into the page. The field-placement editor for
 * uploaded documents is the only thing that needs it, and without it that screen
 * silently fails to render any page.
 *
 * Run from two places on purpose:
 *
 *  - `postinstall`, so a fresh clone works with no extra step;
 *  - `prebuild`, because the Docker image installs dependencies *before* copying
 *    the source tree. At postinstall time inside that build `public/` does not
 *    exist yet, so the copy there is a no-op and production would ship without
 *    the worker. `prebuild` runs after the source is in place, which is the only
 *    moment both halves are guaranteed to exist.
 *
 * Idempotent and never fatal: a missing worker breaks one editor, not the build.
 */
const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const destDir = path.join(__dirname, "..", "public");
const dest = path.join(destDir, "pdf.worker.min.mjs");

try {
  if (!fs.existsSync(src)) {
    console.warn("[pdf-worker] pdfjs-dist not installed yet — skipping");
    process.exit(0);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[pdf-worker] copied to public/ (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
} catch (e) {
  console.warn("[pdf-worker] could not copy:", e.message);
}
