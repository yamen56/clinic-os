/**
 * Builds the sign-in background from `scripts/assets/night-shapes.png`.
 *
 *   npm run night
 *
 * The source is one wide picture (about 2.7:1) with a soft shape in each
 * corner and black between them. Shipped as one image under `cover` it only
 * works on a screen of that shape: a 16:10 laptop crops the top-left shape
 * away, and a phone held upright is shown the middle strip — which is black,
 * so the sign-in screen on a phone was a plain black page.
 *
 * So the shapes are cut out one per corner, and `.surface-night` pins each to
 * its own corner of the screen (see globals.css). Whatever the screen's shape,
 * there is one in every corner.
 *
 * Each piece is the shape's bounding box plus a margin, reaching the picture's
 * own edge where the shape runs off it — that edge is meant to sit on the
 * screen's edge. The inside edges are faded to pure black, so however the
 * pieces meet on a small screen there is no seam; they are layered with
 * `lighten`, which makes their black surroundings disappear.
 *
 * Replacing the source and re-running rebuilds the background. The sizes it
 * prints go into `.surface-night`.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "scripts", "assets", "night-shapes.png");
const OUT = join(process.cwd(), "public", "assets");

async function main() {
  const png = readFileSync(SRC).toString("base64");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // tsx names the helpers below with a `__name` call the page does not have.
  await page.evaluate("window.__name = (f) => f");
  const pieces = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const src = document.createElement("canvas");
    src.width = W;
    src.height = H;
    const sx = src.getContext("2d")!;
    sx.drawImage(img, 0, 0);
    const px = sx.getImageData(0, 0, W, H).data;

    /* Where a shape is: any channel clearly above the black. */
    const lit = (x: number, y: number) => {
      const i = (y * W + x) * 4;
      return Math.max(px[i], px[i + 1], px[i + 2]) > 18;
    };
    const bbox = (x0: number, y0: number, x1: number, y1: number) => {
      let l = x1, t = y1, r = x0, b = y0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          if (lit(x, y)) {
            if (x < l) l = x;
            if (x > r) r = x;
            if (y < t) t = y;
            if (y > b) b = y;
          }
      return { l, t, r, b };
    };

    /* Searched per corner. The split lines sit in the black between shapes. */
    const midX = Math.round(W / 2);
    const regions = {
      tl: bbox(0, 0, midX, Math.round(H * 0.6)),
      bl: bbox(0, Math.round(H * 0.6), midX, H),
      tr: bbox(midX, 0, W, Math.round(H * 0.4)),
      br: bbox(midX, Math.round(H * 0.4), W, H),
    };

    const PAD = 60; // room for the glow to die out before the fade
    const FADE = 48;
    const out: Record<string, { w: number; h: number; x: number; y: number; data: string }> = {};
    for (const [key, r] of Object.entries(regions)) {
      // Reach the picture's edge on the sides where the shape touches it.
      const x = r.l <= 2 ? 0 : Math.max(0, r.l - PAD);
      const y = r.t <= 2 ? 0 : Math.max(0, r.t - PAD);
      const x2 = r.r >= W - 3 ? W : Math.min(W, r.r + PAD);
      const y2 = r.b >= H - 3 ? H : Math.min(H, r.b + PAD);
      const w = x2 - x;
      const h = y2 - y;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      g.drawImage(src, x, y, w, h, 0, 0, w, h);

      // Fade every inside edge — one that is not also the picture's edge — to black.
      // A band FADE wide along one edge, clear on its inner side, black at the edge.
      const fade = (from: [number, number], to: [number, number], rect: [number, number, number, number]) => {
        const grad = g.createLinearGradient(from[0], from[1], to[0], to[1]);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, "rgba(0,0,0,1)");
        g.fillStyle = grad;
        g.fillRect(...rect);
      };
      if (x > 0) fade([FADE, 0], [0, 0], [0, 0, FADE, h]);
      if (x2 < W) fade([w - FADE, 0], [w, 0], [w - FADE, 0, FADE, h]);
      if (y > 0) fade([0, FADE], [0, 0], [0, 0, w, FADE]);
      if (y2 < H) fade([0, h - FADE], [0, h], [0, h - FADE, w, FADE]);

      out[key] = { w, h, x, y, data: c.toDataURL("image/webp", 0.86) };
    }
    return { W, H, out };
  }, png);
  await browser.close();

  console.log(`source ${pieces.W}x${pieces.H}`);
  for (const [key, p] of Object.entries(pieces.out)) {
    const buf = Buffer.from(p.data.split(",")[1], "base64");
    writeFileSync(join(OUT, `night-${key}.webp`), buf);
    console.log(
      `night-${key}.webp  ${p.w}x${p.h}  from (${p.x},${p.y})  ` +
        `right gap ${pieces.W - p.x - p.w}  bottom gap ${pieces.H - p.y - p.h}  ${(buf.length / 1024).toFixed(1)}KB`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
