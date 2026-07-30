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

// pdf.js's worker file. Also run as `prebuild`, which is the run that actually
// lands it — inside the Docker images this postinstall runs before the source
// tree is copied, so `public/` does not exist yet.
//
// Guarded because postinstall runs inside `npm ci`: anything thrown here fails
// the install and takes the entire deploy with it. A missing pdf worker costs
// one editor screen; a failed install costs the whole release.
try {
  require("./copy-pdf-worker.js");
} catch (e) {
  console.warn("[postinstall] pdf worker copy skipped:", e.message);
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
