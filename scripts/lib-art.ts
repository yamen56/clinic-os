/**
 * What the chart art scripts share: value noise, masks and the exact distance
 * transform, one studio light, and laying layers into a picture. Used by
 * render-tooth-art.tsx (chewing surfaces, gum) and render-prosthesis-art.tsx
 * (bridge teeth, implants, the pink base).
 */
import { createCanvas, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { join } from "node:path";

export type V3 = [number, number, number];
export type RGB = [number, number, number];
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const gauss = (d: number, w: number) => Math.exp(-(d * d) / (w * w));

/* ── Noise: value noise, optionally periodic across x (the gum tiles) ───── */
export function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise(x: number, y: number, seed = 1, period = 0): number {
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
export function coverage(paths: string[], w: number, h: number, S: number, dx = 0, dy = 0): Float32Array {
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
export function distance(cov: Float32Array, w: number, h: number): Float32Array {
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
export function soften(hf: Float32Array, cov: Float32Array, w: number, h: number, sigma: number): Float32Array {
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
export const bevel = (d: number, R: number) => {
  const t = 1 - Math.min(d / R, 1);
  return R * Math.sqrt(1 - t * t);
};

/* ── Lighting ────────────────────────────────────────────────────────────── */
export type Surface = {
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
export function shade(n: V3, s: Surface, flipY: boolean): RGB {
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
export type Layer = { cov: Float32Array; color: (x: number, y: number) => RGB | null };

export async function saveArt(dir: string, name: string, w: number, h: number, layers: Layer[]): Promise<Buffer> {
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
  const file = join(dir, `${name}.webp`);
  await sharp(px, { raw: { width: w, height: h, channels: 4 } }).webp({ quality: 88, alphaQuality: 92, effort: 6 }).toFile(file);
  return px;
}

/** Normal of a height field at (x, y), central differences. */
export function normalAt(hf: Float32Array, w: number, h: number, x: number, y: number, k = 1): V3 {
  const at = (xx: number, yy: number) => hf[clamp(yy, 0, h - 1) * w + clamp(xx, 0, w - 1)];
  const dx = (at(x + 1, y) - at(x - 1, y)) / 2;
  const dy = (at(x, y + 1) - at(x, y - 1)) / 2;
  return norm([-dx * k, -dy * k, 1]);
}
