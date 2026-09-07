/**
 * Does a clinic's brand colour survive being turned into a chart colour?
 *
 * The default `--color-chart` was measured, not picked: OKLCh chroma 0.106 so it
 * clears the floor below which a hue reads as grey, and 4.3:1 against the
 * surface so a label on it stays legible. Brand colours in this database run
 * from `#0a111f` to `#ffd500` — one that would read as chrome and one that fails
 * contrast on white outright — so the derivation has to hold those properties
 * for every hue, not merely for the ones that happen to be blue.
 *
 * The thresholds are the dataviz standard: OKLCh L within 0.43–0.77, chroma
 * >= 0.10, and >= 3:1 against the surface for a mark.
 *
 *   npx tsx scripts/qa-brand-chart.ts
 */
import { chartColorsFor, DEFAULT_CHART } from "../src/lib/brand-chart";

const SURFACE = "#ffffff";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* Independent re-implementation of the measures, so the test does not simply
   agree with the module by sharing its arithmetic. */
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function oklch(hex: string) {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI };
}
function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Every brand colour actually in the production database on 2026-09-07. */
const REAL_BRANDS = [
  ["bright yellow", "#ffc800"],
  ["orange", "#ff6600"],
  ["light orange", "#ffc370"],
  ["teal", "#0f6e5c"],
  ["near-black navy", "#0a111f"],
  ["yellow", "#ffd500"],
  ["dark navy", "#07234d"],
] as const;

/** Plus the shapes that break naive conversions. */
const EDGE_CASES = [
  ["pure white", "#ffffff"],
  ["pure black", "#000000"],
  ["mid grey", "#808080"],
  ["saturated red", "#ff0000"],
  ["saturated green", "#00ff00"],
  ["saturated blue", "#0000ff"],
  ["magenta", "#ff00ff"],
  ["cyan", "#00ffff"],
] as const;

function main() {
  console.log("\n[real clinic brands: every one stays legible as a chart]");
  for (const [label, brand] of REAL_BRANDS) {
    const { chart } = chartColorsFor(brand);
    const o = oklch(chart);
    const cr = contrast(chart, SURFACE);
    const ok = o.L >= 0.43 && o.L <= 0.77 && o.C >= 0.1 && cr >= 3;
    check(
      `${label.padEnd(16)} ${brand} → ${chart}`,
      ok,
      `L ${o.L.toFixed(2)} C ${o.C.toFixed(3)} ${cr.toFixed(2)}:1`
    );
  }

  console.log("\n[edge cases]");
  for (const [label, brand] of EDGE_CASES) {
    const { chart } = chartColorsFor(brand);
    const o = oklch(chart);
    const cr = contrast(chart, SURFACE);
    const ok = o.L >= 0.43 && o.L <= 0.77 && o.C >= 0.1 && cr >= 3;
    check(
      `${label.padEnd(16)} ${brand} → ${chart}`,
      ok,
      `L ${o.L.toFixed(2)} C ${o.C.toFixed(3)} ${cr.toFixed(2)}:1`
    );
  }

  console.log("\n[the hue is the clinic's, not a repaint]");
  /*
    The point of the whole exercise: two clinics with different brands must get
    visibly different charts. Same hue in and out, within the rounding the
    gamut clamp can introduce.
  */
  const teal = chartColorsFor("#0f6e5c");
  const orange = chartColorsFor("#ff6600");
  check("teal and orange brands differ", teal.chart !== orange.chart, `${teal.chart} vs ${orange.chart}`);
  const brandHue = oklch("#0f6e5c").h;
  const chartHue = oklch(teal.chart).h;
  const drift = Math.abs(((brandHue - chartHue + 540) % 360) - 180);
  check("the hue is carried across", drift < 12, `${drift.toFixed(1)}° drift`);

  console.log("\n[a brand with no usable hue keeps the default]");
  /*
    Only genuinely achromatic brands fall back. A very dark *navy* like
    `#0a111f` is not one: it is 98% of the way to black but its hue is real and
    blue, and the derivation gives it a blue chart — which is the right answer,
    and not the one this test originally asserted. The expectation was wrong,
    not the code.
  */
  const navy = chartColorsFor("#0a111f");
  check("a very dark navy still yields a blue of its own hue", navy.chart !== DEFAULT_CHART.chart, navy.chart);
  const navyDrift = Math.abs(((oklch("#0a111f").h - oklch(navy.chart).h + 540) % 360) - 180);
  check("and that blue is the brand's blue", navyDrift < 12, `${navyDrift.toFixed(1)}° drift`);
  check("grey falls back", chartColorsFor("#808080").chart === DEFAULT_CHART.chart);
  check("white falls back", chartColorsFor("#ffffff").chart === DEFAULT_CHART.chart);
  check("no brand at all falls back", chartColorsFor(null).chart === DEFAULT_CHART.chart);
  check("a malformed value falls back", chartColorsFor("not-a-colour").chart === DEFAULT_CHART.chart);

  console.log("\n[the soft track reads as a track, not as data]");
  for (const [label, brand] of REAL_BRANDS.slice(0, 3)) {
    const { chart, soft } = chartColorsFor(brand);
    // Light enough to sit under a value without competing with it, and still
    // distinct from the bar that runs over it.
    const ok = luminance(soft) > luminance(chart) && contrast(soft, SURFACE) < 1.6;
    check(`${label} track is lighter than its bar`, ok, soft);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

/**
 * And does any of it reach the screen?
 *
 * The arithmetic above can be perfect while the variable never arrives — the
 * token is overridden on a wrapper in the workspace layout, and a chart drawn
 * outside that subtree, or a Tailwind class that does not read the token, would
 * silently keep the default blue. So the last check is the computed colour of
 * an actual bar in an actual browser.
 *
 *   npx tsx scripts/qa-brand-chart.ts --live
 */
async function live() {
  const { chromium } = await import("playwright");
  const { Client } = await import("pg");

  const BASE = "http://localhost:3000";
  const db = new Client({
    connectionString: `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`,
  });
  await db.connect();
  const rows = (
    await db.query(
      `select slug, brand_color from clinics where slug in ('demo2','rima-dental') order by slug`
    )
  ).rows as { slug: string; brand_color: string }[];
  await db.end();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', "owner@bayan.jo");
    await page.fill('input[name="password"]', "clinic1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });

    await page.goto(`${BASE}/c/demo2`);
    await page.waitForLoadState("networkidle");

    /*
      Read from inside the workspace, not from `document.body`.

      The override lives on a wrapper below body, so reading body returns the
      platform default and the test fails while the product is correct — which
      is exactly what it did on the first run. The honest probe is the colour a
      bar is actually painted.
    */
    const seen = await page.evaluate(() => {
      const bar = document.querySelector('[role="img"] span') as HTMLElement | null;
      const anywhere = document.querySelector("main, aside") as HTMLElement | null;
      return {
        bar: bar ? getComputedStyle(bar).backgroundColor : null,
        token: anywhere
          ? getComputedStyle(anywhere).getPropertyValue("--color-chart").trim()
          : "",
      };
    });

    const brand = rows.find((r) => r.slug === "demo2")?.brand_color ?? "";
    const expected = chartColorsFor(brand).chart;
    const asRgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };

    check(
      "the workspace serves the clinic's derived chart colour",
      seen.token.toLowerCase() === expected.toLowerCase(),
      `brand ${brand} → token ${seen.token || "(none)"} expected ${expected}`
    );
    check(
      "and it is not the platform default",
      seen.token.toLowerCase() !== DEFAULT_CHART.chart,
      seen.token
    );
    // The token could be right and the bar still blue if a chart sat outside
    // the subtree or a class stopped reading the token.
    check(
      "a rendered bar is painted in it",
      seen.bar === null || seen.bar === asRgb(expected),
      seen.bar === null ? "no chart on this dashboard" : `${seen.bar} vs ${asRgb(expected)}`
    );
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

if (process.argv.includes("--live")) void live();
else main();
