/**
 * Generates the PWA icon set from the Makan mark.
 *
 * The mark is never redrawn — each icon is the real asset composited onto a
 * brand plate at the right size. Maskable icons keep the mark inside the 80%
 * safe zone so Android's circular/squircle crops never clip it.
 *
 *   npm run icons
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "public", "icons");
const MARK = join(process.cwd(), "public", "assets", "logo-mark-primary.png");

// Night surface: the mark is slate blue, so it needs a dark plate to read well
// at 48px on a home screen. White would wash it out.
const PLATE = "#0b1220";

type Spec = { file: string; size: number; scale: number; plate: string; radius: string };

const SPECS: Spec[] = [
  { file: "icon-192.png", size: 192, scale: 0.62, plate: PLATE, radius: "22%" },
  { file: "icon-512.png", size: 512, scale: 0.62, plate: PLATE, radius: "22%" },
  // Maskable: platform applies its own mask, so fill the square and inset more.
  { file: "icon-maskable-512.png", size: 512, scale: 0.48, plate: PLATE, radius: "0" },
  // iOS applies its own rounding and does not support transparency.
  { file: "apple-touch-icon.png", size: 180, scale: 0.62, plate: PLATE, radius: "0" },
  // Monochrome-ish badge for Android notifications (small, must stay legible).
  { file: "badge.png", size: 96, scale: 0.72, plate: "transparent", radius: "0" },
];

async function main() {
  const dataUri = `data:image/png;base64,${readFileSync(MARK).toString("base64")}`;
  const browser = await chromium.launch();

  for (const s of SPECS) {
    const page = await browser.newPage({
      viewport: { width: s.size, height: s.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<html><body style="margin:0">
      <div style="width:${s.size}px;height:${s.size}px;border-radius:${s.radius};
                  background:${s.plate};display:grid;place-items:center">
        <img src="${dataUri}" style="width:${Math.round(s.size * s.scale)}px;
             height:${Math.round(s.size * s.scale)}px;object-fit:contain"
             ${s.plate === "transparent" ? 'style2=""' : ""}>
      </div></body></html>`);
    await page.waitForTimeout(120);
    const buf = await page.screenshot({ omitBackground: s.plate === "transparent" });
    writeFileSync(join(OUT, s.file), buf);
    await page.close();
    console.log(`[icons] ${s.file} (${s.size}px)`);
  }

  await browser.close();
  console.log(`[icons] ${SPECS.length} icons written`);
}

main().catch((e) => {
  console.error("[icons]", e.message);
  process.exit(1);
});
