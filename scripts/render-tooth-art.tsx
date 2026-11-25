/**
 * Bakes the dental chart's chewing surfaces and gum into shaded pictures.
 * (The teeth from the side are photographs since 2026-11-03 — see
 * bake-tooth-photos.tsx.)
 *
 * Yamen, 2026-11-03: "make the dental chart tooth look more realistic, kind of
 * like the face chart" — and the face chart is a 3D render, not a drawing.
 * So the teeth are rendered: each outline the chart already draws (crownPath,
 * rootGeom, topOutline, the gum's festoon) becomes a height field — rounded
 * from its edges, with lobes, ridges, cusps and grooves where the tooth has
 * them — lit like a studio render: glossy enamel, a warm neck, a translucent
 * biting edge, matte roots, wet stippled gum.
 *
 * Rendering from the chart's own outlines is the point. Every filling, crown,
 * canal and status edge is still drawn by tooth-art.tsx on those outlines, so
 * it lands exactly on the picture; only the paint underneath changed.
 *
 *   npx tsx scripts/render-tooth-art.tsx   → public/charts/teeth/*.webp
 *                                          + scripts/qa-shots/tooth-art/sprites.png
 *
 * Run it again after changing a shape in tooth-art.tsx, and bump ART_VERSION.
 */
import "./lib-react-global";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tooth, PERMANENT_UPPER, PERMANENT_LOWER, PRIMARY_UPPER, PRIMARY_LOWER, type Tooth } from "../src/lib/charts/dental/teeth";
import { CW, SIDE_H, OCC, GEOM, GUM_PAD, festoon, topOutline, topArtKey } from "../src/components/charts/dental/tooth-art";
import { bevel, clamp, coverage, distance, gauss, hex, mix, noise, normalAt, saveArt, shade, smooth, soften, type Layer, type RGB } from "./lib-art";
import { renderGum } from "./lib-gum";

const OUT = join(process.cwd(), "public", "charts", "teeth");
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "tooth-art");
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const { GUM_TOP } = GEOM;
const SIDE_S = 5; // pixels per drawing unit: the tooth's full view is ~3.4 px/unit on a 2x phone
const TOP_S = 6;
const save = (name: string, w: number, h: number, layers: Layer[]) => saveArt(OUT, name, w, h, layers);


/* ── Colours (the side view is photographs now: bake-tooth-photos.tsx) ──── */
const ENAMEL = hex("#f4f2ed"); // the photographs' enamel: white with a cool cast
const ENAMEL_NECK = hex("#e6dccb");
const PRIMARY_ENAMEL = hex("#f9f6ee");

/* ── The tooth from above ────────────────────────────────────────────────── */
type Bump = [number, number, number, number]; // x, y, radius, height share
type Groove = { pts: [number, number][]; width: number; depth: number };

function topAnatomy(t: Tooth): { cusps: Bump[]; grooves: Groove[]; pits: Bump[] } {
  const upper = t.arch === "upper";
  // Buccal is at the top for an upper tooth and at the bottom for a lower one (surfaceAt).
  const by = (yUpper: number) => (upper ? yUpper : OCC - yUpper);
  if (t.kind === "molar") {
    if (t.primary)
      return {
        cusps: [
          [14, by(14), 6, 0.5],
          [30, by(14), 6, 0.5],
          [14, by(30), 6, 0.42],
          [30, by(30), 6, 0.42],
        ],
        grooves: [
          { pts: [[9, 22], [16, 21], [22, 22.5], [28, 21], [35, 22]], width: 1.1, depth: 0.32 },
          { pts: [[22, 12], [22, 32]], width: 1, depth: 0.22 },
        ],
        pits: [[22, 22, 1.6, 0.25]],
      };
    if (!upper && t.position === 6) {
      // A lower first molar: three buccal cusps (now at the bottom), two lingual.
      return {
        cusps: [
          [11.5, 30.5, 5.6, 0.48],
          [22.5, 32, 5.4, 0.45],
          [33, 30, 4.6, 0.38],
          [13.5, 13.5, 6, 0.55],
          [30.5, 13.5, 6, 0.52],
        ],
        grooves: [
          { pts: [[7, 22], [14, 21.5], [22, 22.5], [29, 21.5], [37, 22.5]], width: 1.1, depth: 0.36 },
          { pts: [[17, 22], [17, 36]], width: 0.9, depth: 0.25 },
          { pts: [[28, 22], [28.5, 35]], width: 0.9, depth: 0.22 },
          { pts: [[22, 22], [22, 9]], width: 0.9, depth: 0.22 },
        ],
        pits: [
          [22, 22.5, 1.8, 0.3],
          [10, 22, 1.2, 0.2],
          [35, 22, 1.2, 0.2],
        ],
      };
    }
    if (upper)
      // An upper molar: four cusps, the mesiolingual the largest, and the oblique ridge across.
      return {
        cusps: [
          [13, 13, 6.2, 0.5],
          [30.5, 13.5, 5.8, 0.48],
          [13.5, 30.5, 6.6, 0.55],
          [30, 30.5, 5, 0.4],
        ],
        grooves: [
          { pts: [[7, 21], [14, 20.5], [20, 19]], width: 1.1, depth: 0.34 },
          { pts: [[24, 25], [30, 23.5], [37, 23]], width: 1.1, depth: 0.34 },
          { pts: [[22, 7], [21.5, 14], [20, 19]], width: 1, depth: 0.28 },
          { pts: [[24, 25], [22.5, 31], [22, 37]], width: 1, depth: 0.28 },
        ],
        pits: [
          [20, 19, 1.6, 0.28],
          [24, 25, 1.6, 0.28],
        ],
      };
    return {
      cusps: [
        [13.5, 13.5, 6.4, 0.5],
        [30.5, 13.5, 6.4, 0.5],
        [13.5, 30.5, 6.4, 0.5],
        [30.5, 30.5, 6.4, 0.5],
      ],
      grooves: [
        { pts: [[8, 22], [15, 20.8], [22, 22], [29, 23.2], [36, 22]], width: 1.1, depth: 0.34 },
        { pts: [[22, 8], [20.8, 15], [22, 22], [23.2, 29], [22, 36]], width: 1, depth: 0.28 },
      ],
      pits: [[22, 22, 1.7, 0.3]],
    };
  }
  if (t.kind === "premolar") {
    // The buccal cusp is the taller one.
    return {
      cusps: [
        [22, by(13.5), 6.8, 0.6],
        [22, by(30.5), upper ? 6 : 4.6, upper ? 0.5 : 0.34],
      ],
      grooves: [{ pts: [[11, 22], [17, 21.2], [22, 22], [27, 22.8], [33, 22]], width: 1.1, depth: 0.34 }],
      pits: [
        [14.5, 22, 1.2, 0.22],
        [29.5, 22, 1.2, 0.22],
      ],
    };
  }
  if (t.kind === "canine")
    return {
      cusps: [[22, 21, 7.5, 0.75]],
      grooves: [],
      pits: [],
    };
  // An incisor: the biting edge is a ridge, the hollow behind it is on the lingual side.
  return {
    cusps: [
      [22, by(18.5), 10, 0.28],
      [22, by(31), 5, 0.25], // the cingulum
    ],
    grooves: [{ pts: [[13, by(25)], [22, by(26.5)], [31, by(25)]], width: 3.2, depth: 0.16 }],
    pits: [],
  };
}

function distToPolyline(x: number, y: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [x1, y1] = pts[k];
    const [x2, y2] = pts[k + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - x1) * dx + (y - y1) * dy) / l2);
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}

const FISSURE = hex("#a98c6a");

async function top(t: Tooth) {
  const S = TOP_S;
  const w = OCC * S;
  const h = OCC * S;
  const outline = topOutline(t);
  const cov = coverage([outline], w, h, S);
  const dist = distance(cov, w, h);
  const { cusps, grooves, pits } = topAnatomy(t);
  const R = 9 * S;
  const dome = new Float32Array(w * h);
  for (let i = 0; i < dome.length; i++) dome[i] = cov[i] > 0 ? bevel(dist[i], R) * 0.55 : 0;
  const domeSoft = soften(dome, cov, w, h, 1.4 * S);
  const hf = new Float32Array(w * h);
  const valley = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cov[i] <= 0) continue;
      const ux = x / S;
      const uy = y / S;
      let v = domeSoft[i];
      for (const [cx, cy, r, k] of cusps) v += R * k * gauss(Math.hypot(ux - cx, uy - cy), r);
      let dip = 0;
      for (const gr of grooves) dip += gr.depth * gauss(distToPolyline(ux, uy, gr.pts), gr.width * 0.62);
      for (const [cx, cy, r, k] of pits) dip += k * gauss(Math.hypot(ux - cx, uy - cy), r);
      v -= R * dip * 0.75;
      v += 0.3 * (noise(ux * 1.2, uy * 1.2, 41) - 0.5);
      hf[i] = v;
      valley[i] = clamp(dip / 0.42);
    }
  }
  const color = (x: number, y: number): RGB => {
    const i = y * w + x;
    const ux = x / S;
    const uy = y / S;
    let a: RGB = t.primary ? PRIMARY_ENAMEL : ENAMEL;
    // Warmer toward the middle of the table, the fissures stained the way they are in every mouth.
    a = mix(a, ENAMEL_NECK, 0.18 * (1 - smooth(0, 6 * S, dist[i])) + 0.12 * smooth(0.2, 0.9, valley[i]));
    a = mix(a, FISSURE, 0.42 * smooth(0.5, 1, valley[i]));
    const m = (noise(ux * 0.4, uy * 0.4, 45) - 0.5) * 0.05;
    const n = normalAt(hf, w, h, x, y);
    const ao = (0.8 + 0.2 * smooth(0, 2 * S, dist[i])) * (1 - 0.25 * valley[i]);
    const c = shade(n, { albedo: [a[0] + m, a[1] + m, a[2] + m * 0.8], gloss: 0.82, wrap: 0.4, ao }, false);
    const rim = 1 - 0.16 * (1 - smooth(0, 1.4, dist[i]));
    return [c[0] * rim, c[1] * rim * 0.98, c[2] * rim * 0.94];
  };
  return save(`top-${topArtKey(t)}`, w, h, [{ cov, color }]);
}

/* ── Everything, once each ───────────────────────────────────────────────── */
async function main() {
  const all = [...PERMANENT_UPPER, ...PERMANENT_LOWER, ...PRIMARY_UPPER, ...PRIMARY_LOWER].map(tooth);
  const tops = new Map<string, Tooth>();
  for (const t of all) if (!tops.has(topArtKey(t))) tops.set(topArtKey(t), t);
  const sheet: { name: string; w: number; h: number; px: Buffer }[] = [];
  for (const [k, t] of tops) sheet.push({ name: `top-${k}`, w: OCC * TOP_S, h: OCC * TOP_S, px: await top(t) });
  for (const a of ["upper", "lower"] as const) {
    const g = await renderGum(OUT, `gum-${a === "upper" ? "u" : "l"}`, a, [festoon(GUM_TOP - 40), festoon(GUM_TOP - 40), festoon(GUM_TOP - 40)]);
    sheet.push({ name: `gum-${a}`, w: g.w, h: SIDE_H * SIDE_S, px: g.px });
  }
  console.log(`baked ${sheet.length} pictures into public/charts/teeth`);

  // A contact sheet to look at.
  const cols = 10;
  const cellW = (CW + 2 * GUM_PAD) * SIDE_S + 20;
  const cellH = SIDE_H * SIDE_S + 20;
  const rows = Math.ceil(sheet.length / cols);
  const parts = await Promise.all(sheet.map((p) => sharp(p.px, { raw: { width: p.w, height: p.h, channels: 4 } }).png().toBuffer()));
  await sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(parts.map((input, k) => ({ input, left: (k % cols) * cellW + 10, top: Math.floor(k / cols) * cellH + 10 })))
    .png()
    .toFile(join(SHOTS, "sprites.png"));
  console.log("contact sheet: scripts/qa-shots/tooth-art/sprites.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
