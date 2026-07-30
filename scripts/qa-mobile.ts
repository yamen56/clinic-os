/**
 * Phone QA: the things that were actually wrong on a handset, measured.
 *
 * Every check here is a geometry or computed-style reading rather than a
 * screenshot comparison, because the bugs it covers are all of the kind that
 * look plausible in a screenshot — a switch knob two pixels off its track, a
 * menu that opens on the wrong side of the bar it belongs to, a font size one
 * pixel under the threshold that makes iOS zoom the page.
 *
 * Needs the stack running: npm run dev:all
 */
try {
  process.loadEnvFile?.();
} catch {
  /* rely on the real environment */
}

import { chromium, devices, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const SLUG = "rima-dental";
const EMAIL = "rima@clinic.jo";
const PASSWORD = "clinic1234";
const SHOTS = join(process.cwd(), "scripts", "qa-shots");

let passed = 0;
const failures: string[] = [];

function check(cond: unknown, label: string, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failures.push(`${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
    console.log(`✗ ${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
  }
}

/**
 * The dev server paints its own overlay in the bottom corner, and its portal
 * swallows taps aimed at the tab bar underneath. It does not exist in the
 * built app, so hiding it measures the real thing rather than the harness.
 */
async function go(page: Page, path: string) {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

/** The page must never scroll sideways — the single loudest "broken on mobile" tell. */
async function noSideScroll(page: Page, where: string) {
  const over = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  check(over <= 1, `no horizontal scroll · ${where}`, over > 1 ? `${over}px of overflow` : undefined);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ---- login screen: the input font size that decides whether iOS zooms
  await go(page, "/login");
  const fontPx = await page.evaluate(() => {
    const el = document.querySelector('input[name="email"]');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  check(
    fontPx >= 16,
    `login field is ${fontPx}px (iOS zooms the page below 16)`,
    fontPx < 16 ? `${fontPx}px` : undefined
  );
  await noSideScroll(page, "login");
  await page.screenshot({ path: join(SHOTS, "mobile-login.png") });

  // ---- the app shell
  await login(page);
  await go(page, `/c/${SLUG}`);
  await noSideScroll(page, "dashboard");
  await page.screenshot({ path: join(SHOTS, "mobile-dashboard.png") });

  // ---- the More sheet must open ABOVE the tab row, not below it
  const tabRow = await page.locator("nav.fixed .grid").first().boundingBox();
  await page.click(`nav.fixed button[aria-expanded]`);
  await page.waitForTimeout(320);
  const sheet = await page.locator("nav.fixed div.overflow-y-auto").first().boundingBox();
  check(
    !!sheet && !!tabRow && sheet.y + sheet.height <= tabRow.y + 2,
    "More sheet opens above the tab bar",
    sheet && tabRow ? `sheet ends ${Math.round(sheet.y + sheet.height)}, tabs start ${Math.round(tabRow.y)}` : "not found"
  );
  check(
    !!sheet && sheet.y >= 0,
    "More sheet is fully on screen",
    sheet ? `top ${Math.round(sheet.y)}` : "not found"
  );
  // The whole menu should fit without scrolling on an ordinary handset: a
  // half-cut last row against the tab bar reads as a broken sheet, not as a
  // hint that there is more below.
  const fit = await page.evaluate(() => {
    const el = document.querySelector("nav.fixed div.overflow-y-auto") as HTMLElement | null;
    return el ? { client: el.clientHeight, content: el.scrollHeight } : null;
  });
  check(
    !!fit && fit.content <= fit.client + 1,
    "whole More menu fits without scrolling",
    fit ? `${fit.content}px of content in ${fit.client}px` : "not found"
  );
  await page.screenshot({ path: join(SHOTS, "mobile-more-sheet.png") });

  // ---- tapping the backdrop closes it
  const backdrop = page.locator('button[class*="fixed inset-0"]');
  check(await backdrop.count(), "backdrop rendered behind the sheet");
  await backdrop.first().click({ position: { x: 40, y: 80 } });
  await page.waitForTimeout(320);
  check(
    (await page.locator("nav.fixed div.overflow-y-auto").count()) === 0,
    "tapping outside closes the sheet"
  );

  // ---- the switch: knob inset and travel
  await go(page, `/c/${SLUG}/notifications`);
  const sw = page.locator('[role="switch"]').first();
  if (await sw.count()) {
    const geom = async () => {
      const track = (await sw.boundingBox())!;
      const knob = (await sw.locator("span").first().boundingBox())!;
      return { track, knob };
    };
    const before = await geom();
    const startGap = before.knob.x - before.track.x;
    const endGap = before.track.x + before.track.width - (before.knob.x + before.knob.width);
    // Whichever side the knob rests on depends on its state and on direction;
    // what must hold is that it sits inside the track rather than flush to it.
    check(
      Math.min(startGap, endGap) >= 1.5 && Math.min(startGap, endGap) <= 3,
      `knob sits inside the track (gap ${Math.min(startGap, endGap).toFixed(1)}px)`,
      `start ${startGap.toFixed(1)}, end ${endGap.toFixed(1)}`
    );
    check(
      before.knob.x >= before.track.x - 0.5 &&
        before.knob.x + before.knob.width <= before.track.x + before.track.width + 0.5,
      "knob never overhangs the track"
    );

    await sw.click();
    await page.waitForTimeout(400);
    const after = await geom();
    const moved = Math.abs(after.knob.x - before.knob.x);
    check(moved > 12, `knob travels the track (${moved.toFixed(1)}px)`, `${moved.toFixed(1)}px`);
    check(
      after.knob.x >= after.track.x - 0.5 &&
        after.knob.x + after.knob.width <= after.track.x + after.track.width + 0.5,
      "knob still inside the track after the flip"
    );
    // The transition has to be long enough for the eye to follow the travel.
    const dur = await sw
      .locator("span")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    check(parseFloat(dur) >= 0.18, `knob animates over ${dur}`, dur);
    await page.screenshot({ path: join(SHOTS, "mobile-toggle.png") });
  } else {
    check(false, "found a switch to measure");
  }
  await noSideScroll(page, "notifications");

  // ---- the service worker now registers everywhere, not just here
  const swReady = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg;
  });
  check(swReady, "service worker registered from an ordinary screen");

  // ---- Arabic: the whole shell mirrors without the layout breaking
  await go(page, `/c/${SLUG}/calendar`);
  await noSideScroll(page, "calendar");
  await page.screenshot({ path: join(SHOTS, "mobile-calendar.png") });

  check(errors.length === 0, "no page errors", errors[0]);

  await browser.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
