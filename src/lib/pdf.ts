import { chromium, type Browser } from "playwright";

/**
 * HTML → PDF via headless Chromium (full Arabic/RTL fidelity — the invoice
 * page IS the PDF). One shared browser instance, lazily launched.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cosBrowser: Promise<Browser> | undefined;
}

async function getBrowser(): Promise<Browser> {
  if (!globalThis.__cosBrowser) {
    globalThis.__cosBrowser = chromium.launch({ args: ["--font-render-hinting=none"] });
  }
  const browser = await globalThis.__cosBrowser;
  if (!browser.isConnected()) {
    globalThis.__cosBrowser = chromium.launch({ args: ["--font-render-hinting=none"] });
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
