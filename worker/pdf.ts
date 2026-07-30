import { chromium, type Browser } from "playwright";

/**
 * HTML → PDF via headless Chromium (full Arabic/RTL fidelity — the invoice
 * page IS the PDF). One shared browser instance, lazily launched.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cosBrowser: Promise<Browser> | undefined;
}

function launch(): Promise<Browser> {
  return chromium.launch({ args: ["--font-render-hinting=none"] }).catch((e: Error) => {
    if (/executable doesn't exist|Looks like Playwright/i.test(e.message)) {
      throw new Error(
        "Invoice PDFs need headless Chromium. Run: npx playwright install chromium"
      );
    }
    throw e;
  });
}

async function getBrowser(): Promise<Browser> {
  if (!globalThis.__cosBrowser) {
    globalThis.__cosBrowser = launch();
  }
  const browser = await globalThis.__cosBrowser;
  if (!browser.isConnected()) {
    globalThis.__cosBrowser = launch();
    return globalThis.__cosBrowser;
  }
  return browser;
}

export async function renderUrlToPdf(url: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

/**
 * Screenshots every `.ov-page` element on a URL as a transparent PNG.
 *
 * This is how values get onto an uploaded PDF without re-typesetting it. The
 * original file is never touched; the signatures, dates and text are drawn by
 * the same browser that shapes Arabic correctly, and the resulting layers are
 * composited over the untouched pages by pdf-lib.
 *
 * Doing it as one screenshot per page — rather than stamping strings with
 * pdf-lib directly — is what keeps Arabic readable: pdf-lib writes glyphs in
 * logical order with no shaping, which produces disconnected, reversed text.
 */
export async function renderPageOverlays(url: string): Promise<string[]> {
  const browser = await getBrowser();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    const elements = await page.locator(".ov-page").all();
    const shots: string[] = [];
    for (const el of elements) {
      const buf = await el.screenshot({ omitBackground: true, type: "png" });
      shots.push(Buffer.from(buf).toString("base64"));
    }
    return shots;
  } finally {
    await page.close();
  }
}
