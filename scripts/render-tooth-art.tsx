/**
 * Bakes the dental chart's teeth and gum into shaded pictures.
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
import { createCanvas, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tooth, PERMANENT_UPPER, PERMANENT_LOWER, PRIMARY_UPPER, PRIMARY_LOWER, type Tooth } from "../src/lib/charts/dental/teeth";
import { CW, SIDE_H, OCC, GEOM, GUM_PAD, shapeOf, crownPath, rootGeom, festoon, topOutline, sideArtKey, topArtKey } from "../src/components/charts/dental/tooth-art";

const OUT = join(process.cwd(), "public", "charts", "teeth");
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "tooth-art");
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const { C, Y0, YB, YE, GUM_TOP, PAP } = GEOM;
const SIDE_S = 5; // pixels per drawing unit: the tooth's full view is ~3.4 px/unit on a 2x phone
const TOP_S = 6;

type V3 = [number, number, number];
type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const gauss = (d: number, w: number) => Math.exp(-(d * d) / (w * w));

/* ── Noise: value noise, optionally periodic across x (the gum tiles) ───── */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, y: number, seed = 1, period = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const wrap = (v: number) => (period ? ((v % period) + period) % period : v);
  const a = hash(wrap(xi), yi, seed);
  const b = hash(wrap(xi + 1), yi, seed);
  const c = hash(wrap(xi), yi + 1, seed);
  const d = hash(wrap(xi + 1), yi + 1, seed);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/* ── Masks and distance ──────────────────────────────────────────────────── */
function coverage(paths: string[], w: number, h: number, S: number, dx = 0, dy = 0): Float32Array {
  const cv = createCanvas(w, h);
  const g = cv.getContext("2d");
  g.setTransform(S, 0, 0, S, dx * S, dy * S);
  g.fillStyle = "#000";
  for (const d of paths) g.fill(new Path2D(d));
  const data = g.getImageData(0, 0, w, h).data;
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] / 255;
  return a;
}

/** Distance (px) from each inside pixel to the nearest outside one — Felzenszwalb's exact transform. */
function distance(cov: Float32Array, w: number, h: number): Float32Array {
  const INF = 1e12;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = cov[i] >= 0.5 ? INF : 0;
  const pass = (n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(Math.min(grid[i], 1e8));
  return out;
}

/**
 * Blurs a height field inside its own outline (normalised by the blurred
 * coverage, so the edge does not sag). The distance transform leaves creases
 * along the middle of a shape — where the nearest edge switches sides — and a
 * real tooth has none: this is what rounds them away.
 */
function soften(hf: Float32Array, cov: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 2.5);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const run = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = horizontal ? x + i : x;
          const yy = horizontal ? y : y + i;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[yy * w + xx] * k[i + r];
        }
        out[y * w + x] = s;
      }
    return out;
  };
  const weighted = new Float32Array(w * h);
  const inside = new Float32Array(w * h);
  for (let i = 0; i < weighted.length; i++) {
    inside[i] = cov[i] > 0 ? 1 : 0;
    weighted[i] = hf[i] * inside[i];
  }
  const num = run(run(weighted, true), false);
  const den = run(run(inside, true), false);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = inside[i] ? num[i] / Math.max(den[i], 1e-4) : 0;
  return out;
}

/** A rounded edge: rises like a quarter circle of radius R, then holds. */
const bevel = (d: number, R: number) => {
  const t = 1 - Math.min(d / R, 1);
  return R * Math.sqrt(1 - t * t);
};

/* ── Lighting ────────────────────────────────────────────────────────────── */
type Surface = {
  albedo: RGB;
  /** 0 matte … 1 glass */
  gloss: number;
  /** Light that wraps round the edge, for things light passes into (enamel, gum). */
  wrap: number;
  ao: number;
};

/**
 * One pixel, lit. The key light is high on the left and in front, as in a
 * studio product shot; a weak fill from the right keeps the shadow side
 * readable. `flipY` lights a lower tooth from below, because the chart turns it
 * upside down to draw it, and after the turn the light is above it again.
 */
function shade(n: V3, s: Surface, flipY: boolean): RGB {
  const key = norm([-0.48, flipY ? 0.58 : -0.58, 0.66]);
  const fill = norm([0.7, flipY ? -0.15 : 0.15, 0.7]);
  const view: V3 = [0, 0, 1];
  const ndl = dot(n, key);
  const diffuse = clamp((ndl + s.wrap) / (1 + s.wrap));
  const fillD = clamp(dot(n, fill));
  const half = norm([key[0] + view[0], key[1] + view[1], key[2] + view[2]]);
  const ndh = clamp(dot(n, half));
  const sharp = Math.pow(ndh, 18 + 110 * s.gloss) * (0.15 + 0.75 * s.gloss);
  const broad = Math.pow(ndh, 6) * 0.1 * s.gloss;
  const fresnel = Math.pow(1 - clamp(n[2]), 3);
  // Light that went in comes out warmer on the shadow side, as it does through enamel and gum.
  const warm: RGB = [1, 0.95 - 0.04 * s.wrap, 0.9 - 0.08 * s.wrap];
  const lit = 0.36 + 0.62 * diffuse + 0.16 * fillD;
  const tint = mix(warm, [1, 1, 1], diffuse);
  const out: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = s.albedo[i] * tint[i] * lit * s.ao * (1 - 0.1 * fresnel) + sharp + broad + 0.05 * fresnel * s.gloss;
  }
  return out;
}

/* ── Picture assembly ────────────────────────────────────────────────────── */
type Layer = { cov: Float32Array; color: (x: number, y: number) => RGB | null };

async function save(name: string, w: number, h: number, layers: Layer[]) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const L of layers) {
        const c = L.cov[i];
        if (c <= 0) continue;
        const col = L.color(x, y);
        if (!col) continue;
        // "over", in premultiplied terms
        r = col[0] * c + r * (1 - c);
        g = col[1] * c + g * (1 - c);
        b = col[2] * c + b * (1 - c);
        a = c + a * (1 - c);
      }
      if (a > 0) {
        px[i * 4] = Math.round(clamp(r / a) * 255);
        px[i * 4 + 1] = Math.round(clamp(g / a) * 255);
        px[i * 4 + 2] = Math.round(clamp(b / a) * 255);
        px[i * 4 + 3] = Math.round(clamp(a) * 255);
      }
    }
  }
  const file = join(OUT, `${name}.webp`);
  await sharp(px, { raw: { width: w, height: h, channels: 4 } }).webp({ quality: 88, alphaQuality: 92, effort: 6 }).toFile(file);
  return px;
}

/** Normal of a height field at (x, y), central differences. */
function normalAt(hf: Float32Array, w: number, h: number, x: number, y: number, k = 1): V3 {
  const at = (xx: number, yy: number) => hf[clamp(yy, 0, h - 1) * w + clamp(xx, 0, w - 1)];
  const dx = (at(x + 1, y) - at(x - 1, y)) / 2;
  const dy = (at(x, y + 1) - at(x, y - 1)) / 2;
  return norm([-dx * k, -dy * k, 1]);
}

/* ── The tooth from the side ─────────────────────────────────────────────── */
const ENAMEL = hex("#f9f5eb");
const ENAMEL_NECK = hex("#eddab0");
const ENAMEL_EDGE = hex("#c9d0d6");
const PRIMARY_ENAMEL = hex("#f9f6ee");
const ROOT = hex("#efdcb4");
const ROOT_APEX = hex("#dfc497");

async function side(t: Tooth) {
  const s = shapeOf(t);
  const S = SIDE_S;
  const w = CW * S;
  const h = SIDE_H * S;
  const flipY = t.arch === "lower";
  const crown = crownPath(s);
  const roots = rootGeom(s);
  const covCrown = coverage([crown], w, h, S);
  const covRoot = coverage([roots.body], w, h, S);
  const covBack = roots.back ? coverage([roots.back], w, h, S) : null;
  const dCrown = distance(covCrown, w, h);
  const dRoot = distance(covRoot, w, h);
  const dBack = covBack ? distance(covBack, w, h) : null;

  // Heights, in pixels.
  const Rc = s.mw * S * 0.9;
  const hCrown = new Float32Array(w * h);
  const front = s.cusp === "incisal" || s.cusp === "canine";
  for (let y = 0; y < h; y++) {
    const uy = y / S;
    const f = (uy - Y0) / (YE - Y0); // 0 at the neck, 1 at the edge
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (covCrown[i] <= 0) continue;
      const ux = x / S;
      let v = bevel(dCrown[i], Rc) * 0.78;
      // The height of contour: the crown is fullest a third of the way down.
      v += Rc * 0.07 * gauss(uy - (Y0 + 9), 7);
      const off = (ux - C) / s.mw; // -1 … 1 across the crown
      if (s.cusp === "incisal") {
        // Three lobes on the face of an incisor, two shallow grooves between them, fading up toward the neck.
        v -= Rc * 0.05 * (gauss(off + 0.34, 0.14) + gauss(off - 0.34, 0.14)) * smooth(0.25, 0.95, f);
      } else if (s.cusp === "canine") {
        v += Rc * 0.1 * gauss(off, 0.28) * smooth(0.05, 0.9, f);
      } else if (s.cusp === "premolar") {
        v += Rc * 0.06 * gauss(off, 0.32) * smooth(0.1, 0.9, f);
      } else {
        // A molar's two buccal cusps, and the groove running up between them.
        v += Rc * 0.06 * (gauss(off + 0.48, 0.3) + gauss(off - 0.48, 0.3)) * smooth(0.45, 1, f);
        v -= Rc * 0.07 * gauss(off, 0.09) * smooth(0.35, 0.95, f);
      }
      hCrown[i] = v;
    }
  }
  const hCrownSoft = soften(hCrown, covCrown, w, h, 1.6 * S);
  for (let y = 0; y < h; y++) {
    const uy = y / S;
    const f = (uy - Y0) / (YE - Y0);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (covCrown[i] <= 0) continue;
      // Perikymata: fine horizontal ripples in the enamel, felt more than seen.
      hCrownSoft[i] += 0.035 * Math.sin(uy * 7.3 + noise((x / S) * 0.6, uy * 0.6, 3) * 2) * smooth(0.1, 0.6, f) * (1 - smooth(0.85, 1, f));
    }
  }
  const rootHeight = (dist: Float32Array, cov: Float32Array, R: number) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cov[i] <= 0) continue;
        out[i] = bevel(dist[i], R) * 0.85 + 0.25 * noise(x / S / 1.6, y / S / 4, 7);
      }
    return soften(out, cov, w, h, 1.1 * S);
  };
  const hRoot = rootHeight(dRoot, covRoot, s.nw * S * 0.55);
  const hBack = covBack && dBack ? rootHeight(dBack, covBack, s.nw * S * 0.45) : null;

  const enamelAt = (x: number, y: number): RGB => {
    const uy = y / S;
    const ux = x / S;
    const f = (uy - Y0) / (YE - Y0);
    let a = mix(ENAMEL_NECK, t.primary ? PRIMARY_ENAMEL : ENAMEL, smooth(0.0, 0.5, f));
    // Translucent at the biting edge: most in incisors, a little in canines, barely in the back.
    const edge = s.cusp === "incisal" ? 0.55 : s.cusp === "canine" ? 0.32 : 0.12;
    a = mix(a, ENAMEL_EDGE, edge * smooth(0.8, 1.0, f) * (0.6 + 0.4 * noise(ux * 0.8, uy * 0.3, 11)));
    // A whisper of mottling: real enamel is never one colour.
    const m = (noise(ux * 0.35, uy * 0.35, 5) - 0.5) * 0.05 + (noise(ux * 1.4, uy * 1.4, 9) - 0.5) * 0.02;
    return [a[0] + m, a[1] + m, a[2] + m * 0.8];
  };

  const crownLayer: Layer = {
    cov: covCrown,
    color: (x, y) => {
      const i = y * w + x;
      const n = normalAt(hCrownSoft, w, h, x, y);
      const ao = 0.82 + 0.18 * smooth(0, 2.2 * S, dCrown[i]);
      const c = shade(n, { albedo: enamelAt(x, y), gloss: front ? 0.85 : 0.75, wrap: 0.45, ao }, flipY);
      // The finest dark line at the very edge, so a tooth still reads on white.
      const rim = 1 - 0.16 * (1 - smooth(0, 1.4, dCrown[i]));
      return [c[0] * rim, c[1] * rim * 0.98, c[2] * rim * 0.94];
    },
  };
  const rootColor = (hf: Float32Array, dist: Float32Array, dim: number) => (x: number, y: number): RGB => {
    const i = y * w + x;
    const uy = y / S;
    const toApex = clamp((Y0 - uy) / (Y0 - s.apex));
    const alb = mix(ROOT, ROOT_APEX, smooth(0.3, 1, toApex));
    const m = (noise(x / S * 0.5, uy * 0.25, 13) - 0.5) * 0.05;
    const n = normalAt(hf, w, h, x, y);
    const c = shade(n, { albedo: [alb[0] + m, alb[1] + m, alb[2] + m], gloss: 0.12, wrap: 0.25, ao: 0.86 + 0.14 * smooth(0, 1.6 * S, dist[i]) }, flipY);
    const rim = 1 - 0.18 * (1 - smooth(0, 1.2, dist[i]));
    return [c[0] * rim * dim, c[1] * rim * dim, c[2] * rim * dim];
  };
  const layers: Layer[] = [];
  if (covBack && hBack && dBack) layers.push({ cov: covBack, color: rootColor(hBack, dBack, 0.78) });
  layers.push({ cov: covRoot, color: rootColor(hRoot, dRoot, 1) });
  layers.push(crownLayer);
  return save(`side-${sideArtKey(t)}`, w, h, layers);
}

/* ── The gum, one column wide, tiling ────────────────────────────────────── */
const GUM_MARGIN = hex("#f1a9a3");
const GUM = hex("#e58f8f");
const MUCOSA = hex("#c8596a");

async function gum(arch: "upper" | "lower") {
  const S = SIDE_S;
  const w = CW * S;
  const h = SIDE_H * S;
  const flipY = arch === "lower";
  /*
    One column of gum, and a sliver of each neighbour's (GUM_PAD a side), so
    two tiles overlap instead of meeting edge to edge: tiles that only meet
    leave a hairline of white where the browser blends their edges. In the
    overlap each tile is drawn at the opacity that, laid over its neighbour's,
    adds up to the gum's own — so the joint is neither lighter nor darker.
  */
  const P = Math.round(GUM_PAD * S);
  const wo = w + 2 * P;
  // Three columns side by side, so the distance to the margin is right at the papillae; the middle one is kept.
  const W3 = w * 3;
  const tissue = festoon(GUM_TOP - 40); // reaching well above the picture, so its top is not an edge
  const cv = createCanvas(W3, h);
  const g = cv.getContext("2d");
  g.fillStyle = "#000";
  for (let k = 0; k < 3; k++) {
    g.setTransform(S, 0, 0, S, k * w, 0);
    g.fill(new Path2D(tissue));
  }
  const data = g.getImageData(0, 0, W3, h).data;
  const cov3 = new Float32Array(W3 * h);
  for (let i = 0; i < cov3.length; i++) cov3[i] = data[i * 4 + 3] / 255;
  const d3 = distance(cov3, W3, h);

  const R = 5.5 * S;
  const hf = new Float32Array(wo * h);
  const cov = new Float32Array(wo * h);
  const dist = new Float32Array(wo * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < wo; x++) {
      const j = y * W3 + (x + w - P);
      const i = y * wo + x;
      cov[i] = cov3[j];
      dist[i] = d3[j];
      if (cov3[j] <= 0) continue;
      const ux = (x - P) / S;
      const uy = y / S;
      // The free margin rolls over the tooth; above it the attached gum is firm and stippled.
      let v = bevel(d3[j], R);
      v += 1.1 * (noise(ux * 1.7, uy * 1.7, 21, Math.round(CW * 1.7)) - 0.5) * smooth(Y0 - 30, Y0 - 4, uy);
      v += 0.5 * (noise(ux * 4.4, uy * 4.4, 23, Math.round(CW * 4.4)) - 0.5);
      // Each tooth's root shows as a gentle swelling under the gum (the juga), between soft hollows.
      v += 1.6 * S * 0.4 * Math.cos(((ux - C) / CW) * Math.PI * 2) * smooth(GUM_TOP, Y0 - 6, uy) * (1 - smooth(Y0 - 6, Y0 + 2, uy));
      hf[i] = v;
    }
  }
  const color = (x: number, y: number): RGB | null => {
    const i = y * wo + x;
    const uy = y / S;
    // Mucosa high up, coral attached gum, a paler rim at the margin.
    let a = mix(MUCOSA, GUM, smooth(Y0 - 30, Y0 - 16, uy));
    a = mix(a, GUM_MARGIN, 1 - smooth(0, 2.2 * S, dist[i]));
    const m = (noise(((x - P) / S) * 0.5, uy * 0.5, 31, Math.round(CW * 0.5)) - 0.5) * 0.06;
    const n = normalAt(hf, wo, h, x, y, 1);
    const c = shade(n, { albedo: [a[0] + m, a[1] + m * 0.6, a[2] + m * 0.6], gloss: 0.55, wrap: 0.6, ao: 1 }, flipY);
    // The sulcus: a fine darker line where the gum meets the tooth.
    const sulcus = 1 - 0.32 * (1 - smooth(0, 0.9 * S, dist[i]));
    return [c[0] * sulcus, c[1] * sulcus * 0.96, c[2] * sulcus * 0.96];
  };
  /*
    How much of the root shows through: none at the margin, more toward the
    mucosa, so an implant, a root canal or a graft drawn on the roots stays in
    sight — the same fade the drawn gum had.
  */
  const fade = new Float32Array(wo * h);
  for (let y = 0; y < h; y++) {
    const uy = y / S;
    const t = clamp((uy - GUM_TOP) / (PAP - GUM_TOP));
    const op = t < 0.32 ? (t / 0.32) * 0.42 : t < 0.6 ? 0.42 + ((t - 0.32) / 0.28) * 0.42 : t < 0.86 ? 0.84 + ((t - 0.6) / 0.26) * 0.13 : 0.97 + ((t - 0.86) / 0.14) * 0.03;
    for (let x = 0; x < wo; x++) {
      const a = cov[y * wo + x] * (uy < GUM_TOP ? 0 : op);
      // In the overlap: the opacity two layers of which make `a` (1 − (1 − b)² = a).
      const shared = x < 2 * P || x >= w;
      fade[y * wo + x] = shared ? 1 - Math.sqrt(Math.max(0, 1 - a)) : a;
    }
  }
  return { w: wo, px: await save(`gum-${arch === "upper" ? "u" : "l"}`, wo, h, [{ cov: fade, color }]) };
}

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

const FISSURE = hex("#b79a70");

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
      for (const gr of grooves) dip += gr.depth * gauss(distToPolyline(ux, uy, gr.pts), gr.width);
      for (const [cx, cy, r, k] of pits) dip += k * gauss(Math.hypot(ux - cx, uy - cy), r);
      v -= R * dip;
      v += 0.3 * (noise(ux * 1.2, uy * 1.2, 41) - 0.5);
      hf[i] = v;
      valley[i] = clamp(dip / 0.35);
    }
  }
  const color = (x: number, y: number): RGB => {
    const i = y * w + x;
    const ux = x / S;
    const uy = y / S;
    let a: RGB = t.primary ? PRIMARY_ENAMEL : ENAMEL;
    // Warmer toward the middle of the table, the fissures stained the way they are in every mouth.
    a = mix(a, ENAMEL_NECK, 0.18 * (1 - smooth(0, 6 * S, dist[i])) + 0.12 * smooth(0.2, 0.9, valley[i]));
    a = mix(a, FISSURE, 0.55 * smooth(0.45, 1, valley[i]));
    const m = (noise(ux * 0.4, uy * 0.4, 45) - 0.5) * 0.05;
    const n = normalAt(hf, w, h, x, y);
    const ao = (0.8 + 0.2 * smooth(0, 2 * S, dist[i])) * (1 - 0.25 * valley[i]);
    const c = shade(n, { albedo: [a[0] + m, a[1] + m, a[2] + m * 0.8], gloss: 0.72, wrap: 0.4, ao }, false);
    const rim = 1 - 0.16 * (1 - smooth(0, 1.4, dist[i]));
    return [c[0] * rim, c[1] * rim * 0.98, c[2] * rim * 0.94];
  };
  return save(`top-${topArtKey(t)}`, w, h, [{ cov, color }]);
}

/* ── Everything, once each ───────────────────────────────────────────────── */
async function main() {
  const all = [...PERMANENT_UPPER, ...PERMANENT_LOWER, ...PRIMARY_UPPER, ...PRIMARY_LOWER].map(tooth);
  const sides = new Map<string, Tooth>();
  const tops = new Map<string, Tooth>();
  for (const t of all) {
    if (!sides.has(sideArtKey(t))) sides.set(sideArtKey(t), t);
    if (!tops.has(topArtKey(t))) tops.set(topArtKey(t), t);
  }
  const sheet: { name: string; w: number; h: number; px: Buffer }[] = [];
  for (const [k, t] of sides) sheet.push({ name: `side-${k}`, w: CW * SIDE_S, h: SIDE_H * SIDE_S, px: await side(t) });
  for (const [k, t] of tops) sheet.push({ name: `top-${k}`, w: OCC * TOP_S, h: OCC * TOP_S, px: await top(t) });
  for (const a of ["upper", "lower"] as const) {
    const g = await gum(a);
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
