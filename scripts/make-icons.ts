/**
 * Generates the PWA icon set from the Clinicti mark.
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

type Spec = {
  file: string;
  size: number;
  scale: number;
  plate: string;
  radius: string;
  /** Written outside public/icons — currently only the email mark. */
  dir?: string;
};

/*
  Which plates are rounded, and why it depends entirely on who masks them.

  Rounding was removed once before because it produced white notches in the
  corners. That was true, and the cause was here rather than in the idea: the
  screenshot only dropped its background for a transparent plate, so a rounded
  navy plate was photographed against the page — and the page is white. The
  corners were not transparent at all, they were painted. `omitBackground` now
  follows the radius, so a rounded icon has genuinely empty corners and sits on
  a tab bar or a wallpaper of any colour.

  That settles the mechanics; the split below is the design decision.

  - **Nothing masks a browser tab or a `purpose: "any"` icon.** They are shown
    exactly as shipped, so they carry their own radius — and without one they
    are a hard navy square among rounded neighbours.
  - **iOS and Android mask their own.** `apple-touch-icon` gets a superellipse
    and no alpha at all (transparent corners come out black), and a `maskable`
    icon is cropped to whatever shape the launcher likes. Both must stay full
    square: a radius here is either double-rounded or clipped away.

  The mark is still sized to fill the frame confidently — at 48px on a home
  screen a timid logo is unreadable.
*/
// ~20% reads as the same family as a home-screen icon without going circular.
const R = "20%";

const SPECS: Spec[] = [
  { file: "icon-192.png", size: 192, scale: 0.82, plate: PLATE, radius: R },
  { file: "icon-512.png", size: 512, scale: 0.82, plate: PLATE, radius: R },
  // Maskable: the platform crops to a circle, so keep the mark in the 80% safe
  // zone and leave the plate square — the crop supplies the shape.
  { file: "icon-maskable-512.png", size: 512, scale: 0.62, plate: PLATE, radius: "0" },
  // iOS applies its own rounding and does not support transparency.
  { file: "apple-touch-icon.png", size: 180, scale: 0.82, plate: PLATE, radius: "0" },
  // Browser tab favicon — tiny, so the mark fills nearly the whole square.
  { file: "favicon.png", size: 256, scale: 0.88, plate: PLATE, radius: R },
  // Android notification badge: silhouetted by the OS, so no plate.
  { file: "badge.png", size: 96, scale: 0.9, plate: "transparent", radius: "0" },
  /*
    The email mark. Generated rather than hand-made because the source mark is
    white on transparency, and an email body is white — dropped in directly it
    would be an invisible rectangle in every invitation we send. On its own navy
    plate it reads on any background a mail client chooses, including dark mode.
  */
  { file: "mark-light.png", size: 256, scale: 0.72, plate: PLATE, radius: "0", dir: "assets" },
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
             height:${Math.round(s.size * s.scale)}px;object-fit:contain">
      </div></body></html>`);
    await page.waitForTimeout(120);
    /*
      Dropped for a radius as well as for a transparent plate, and this is the
      line the rounded corners live or die on. Without it Chromium paints the
      page behind the plate — white — so the "transparent" corners ship as white
      wedges, which is exactly how rounding failed last time.
    */
    const buf = await page.screenshot({
      omitBackground: s.plate === "transparent" || s.radius !== "0",
    });
    const dir = s.dir ? join(process.cwd(), "public", s.dir) : OUT;
    writeFileSync(join(dir, s.file), buf);
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
