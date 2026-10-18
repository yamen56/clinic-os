/**
 * Installs the Chromium used for invoice PDFs — but only where it is actually
 * used and not already present.
 *
 * Both Docker images set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: the worker already
 * ships Chromium in its base layer, and the web image delegates PDF rendering
 * to the worker, so downloading ~150MB of browser into either would slow every
 * build for nothing. This matters for local installs, where it is wanted.
 */
const { execSync } = require("node:child_process");

const skip =
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
