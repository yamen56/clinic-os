import { chromium, type Browser } from "playwright";

/**
 * HTML → PDF via headless Chromium (full Arabic/RTL fidelity — the invoice
 * page IS the PDF). One shared browser instance, lazily launched.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cosBrowser: Promise<Browser> | undefined;
  // eslint-disable-next-line no-var
  var __cosBrowserIdleTimer: NodeJS.Timeout | undefined;
  /** Renders served by the current browser; see MAX_RENDERS_PER_BROWSER. */
  // eslint-disable-next-line no-var
  var __cosBrowserRenders: number | undefined;
}

/**
 * How many renders one browser may serve before it is replaced.
 *
 * A long-lived Chromium degrades. Observed repeatedly on this worker: after a
 * few hours of use every render starts failing with `browser.newPage: Target
 * crashed`, invoicing and both signing suites go red together, and a fresh
 * `chromium.launch()` in a throwaway script works perfectly — so it is the
 * instance, not the code.
 *
 * The idle shutdown below already covers a quiet worker. This covers a busy
 * one, which is the case that actually broke: renders keep arriving, the idle
 * timer never fires, and the same process holds the same browser for days.
 *
 * Two hundred is well past a clinic's daily volume and well short of where the
 * degradation has been seen, so in normal use this never fires and in abnormal
 * use it fires before anybody notices.
 */
const MAX_RENDERS_PER_BROWSER = Number(process.env.PDF_MAX_RENDERS || 200);

/**
 * Failures that mean "this browser is finished", as opposed to "this page did
 * not work".
 *
 * The distinction matters because the response differs: a crashed target is
 * worth retrying once on a new browser, and a 30-second navigation timeout is
 * not — retrying that just makes the caller wait sixty seconds for the same
 * answer.
 */
export function isBrowserDead(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? "");
  return /Target crashed|Target closed|Browser has been closed|browser has disconnected|Protocol error|Connection closed/i.test(
    msg
  );
}

/** Drops the shared browser so the next caller launches a new one. */
function discardBrowser(reason: string): void {
  const pending = globalThis.__cosBrowser;
  globalThis.__cosBrowser = undefined;
  globalThis.__cosBrowserRenders = 0;
  if (globalThis.__cosBrowserIdleTimer) {
    clearTimeout(globalThis.__cosBrowserIdleTimer);
    globalThis.__cosBrowserIdleTimer = undefined;
  }
  console.log(`[pdf] replacing chromium (${reason})`);
  // Closing is best-effort and deliberately not awaited: a browser that has
  // already crashed may never answer, and the caller is waiting on a render.
  void pending?.then((b) => (b.isConnected() ? b.close() : undefined)).catch(() => {});
}

/**
 * Runs a render, and if the browser dies under it, runs it once more on a fresh
 * one.
 *
 * `isConnected()` in `getBrowser` is not enough on its own: the failure seen in
 * practice is a browser that is still connected and can no longer open a page.
 * That check waves it straight through, and every subsequent render fails the
 * same way until the process restarts.
 */
export async function withFreshRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isBrowserDead(e)) throw e;
    discardBrowser(`${what}: ${String((e as Error).message).slice(0, 80)}`);
    return run();
  }
}

/**
 * How long an unused Chromium is kept warm before being shut down.
 *
 * It used to be kept forever. Launching is slow — a second or two — so holding
 * one open made every render after the first feel instant, and on a machine you
 * already own that is simply free.
 *
 * On metered hosting it is not free: the browser is several hundred megabytes
 * resident, billed by the second, and a clinic renders a handful of PDFs a day.
 * That is paying around the clock for something used for a few minutes.
 *
 * Five minutes keeps a burst fast — sending a document, then its invoice,
 * reuses the same browser — while a quiet afternoon costs nothing. The price is
 * a one-off second on the first render after a lull, which nobody waiting on a
 * PDF will notice.
 */
const IDLE_SHUTDOWN_MS = Number(process.env.PDF_BROWSER_IDLE_MS || 5 * 60_000);

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

/** Restarts the idle countdown. Called after every render finishes. */
function touchBrowser(): void {
  if (globalThis.__cosBrowserIdleTimer) clearTimeout(globalThis.__cosBrowserIdleTimer);
  if (IDLE_SHUTDOWN_MS <= 0) return;
  const timer = setTimeout(() => {
    const pending = globalThis.__cosBrowser;
    globalThis.__cosBrowser = undefined;
    globalThis.__cosBrowserIdleTimer = undefined;
    void pending
      ?.then((b) => (b.isConnected() ? b.close() : undefined))
      .then(() => console.log("[pdf] chromium closed after idle"))
      .catch(() => {});
  }, IDLE_SHUTDOWN_MS);
  // Must not keep the worker alive on its own account.
  timer.unref?.();
  globalThis.__cosBrowserIdleTimer = timer;
}

async function getBrowser(): Promise<Browser> {
  // Any in-flight render cancels the shutdown; re-armed when it completes.
  if (globalThis.__cosBrowserIdleTimer) {
    clearTimeout(globalThis.__cosBrowserIdleTimer);
    globalThis.__cosBrowserIdleTimer = undefined;
  }
  // Retired on count before it can degrade, rather than after it has.
  if ((globalThis.__cosBrowserRenders ?? 0) >= MAX_RENDERS_PER_BROWSER) {
    discardBrowser(`${globalThis.__cosBrowserRenders} renders`);
  }
  if (!globalThis.__cosBrowser) {
    globalThis.__cosBrowser = launch();
    globalThis.__cosBrowserRenders = 0;
  }
  const browser = await globalThis.__cosBrowser;
  if (!browser.isConnected()) {
    globalThis.__cosBrowser = launch();
    globalThis.__cosBrowserRenders = 0;
    return globalThis.__cosBrowser;
  }
  globalThis.__cosBrowserRenders = (globalThis.__cosBrowserRenders ?? 0) + 1;
  return browser;
}

export function renderUrlToPdf(url: string): Promise<Buffer> {
  return withFreshRetry("render", async () => {
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
      // Best-effort: closing a page on a crashed browser throws, and that must
      // not replace the real error with a confusing one from the cleanup.
      await page.close().catch(() => {});
      touchBrowser();
    }
  });
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
export function renderPageOverlays(url: string): Promise<string[]> {
  return withFreshRetry("overlays", async () => {
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
      await page.close().catch(() => {});
      touchBrowser();
    }
  });
}
