/**
 * Installs the Chromium used for invoice PDFs — but only where it is actually
 * used and not already present.
 *
 * Skipped on Vercel: the web app delegates PDF rendering to the worker, so
 * downloading ~150MB of browser there would slow every build for nothing (and
 * can trip the build image's size limits). The worker's Docker image ships
 * Chromium in its base layer, so it skips too.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/*
  pdf.js runs its parser in a Web Worker, which has to be a real file the browser
  can fetch — it cannot be bundled into the page. Copy it next to the other
  static assets so the field-placement editor works with no CDN, on the same
  terms as the self-hosted fonts.
*/
try {
  const src = path.join(
    __dirname,
    "..",
    "node_modules",
    "pdfjs-dist",
    "build",
    "pdf.worker.min.mjs"
  );
  const dest = path.join(__dirname, "..", "public", "pdf.worker.min.mjs");
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log("[postinstall] copied pdf.js worker to public/");
  }
} catch (e) {
  console.warn("[postinstall] could not copy pdf.js worker:", e.message);
}

const skip =
  process.env.VERCEL ||
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ||
  process.env.PLAYWRIGHT_BROWSERS_PATH === "0";

if (skip) {
  console.log("[postinstall] skipping Chromium download (not needed here)");
  process.exit(0);
}

try {
  const { chromium } = require("playwright");
  require("node:fs").accessSync(chromium.executablePath());
  console.log("[postinstall] Chromium already present");
} catch {
  console.log("[postinstall] installing Chromium for invoice PDFs…");
  try {
    execSync("npx playwright install chromium", { stdio: "inherit" });
  } catch {
    // Non-fatal: the app runs, and PDF rendering explains itself if attempted.
    console.warn("[postinstall] Chromium install failed — run: npx playwright install chromium");
  }
}
