/**
 * Bakes what a prosthesis is drawn with: the teeth of a bridge, an implant and
 * its abutments, the pink base of a full arch or a denture, and the healed gum
 * where a tooth is gone.
 *
 * Yamen, 2026-11-25: "the prosthetics or the bridge … make sure everything
 * looks perfect, not just lines … realistic good looking". A bridge used to be
 * the teeth's own pictures outlined in blue and joined by small boxes, with
 * gaps between them; a real bridge is one piece, its teeth fused where they
 * touch.
 *
 * - A bridge tooth is the chart's own tooth photograph, re-fitted so that its
 *   contact reaches the edge of its column — neighbours meet there and nowhere
 *   else, so the gaps above and below the contact are the ones a bridge has —
 *   and brought to one porcelain shade, so a span reads as one piece.
 * - An implant is turned on a lathe: a helical thread on a tapering core,
 *   blasted titanium with a polished collar, lit like a product photograph.
 * - The pink base and the healed ridge are the gum renderer's tissue with
 *   their own edges.
 *
 *   npx tsx scripts/render-prosthesis-art.tsx
 *     → public/charts/teeth/{unit,implant,abut,base,ridge}-*.webp
 *     → src/components/charts/dental/prosthesis-units.ts
 *     → scripts/qa-shots/tooth-art/prosthesis-sprites.png
 *
 * Run it again after changing prosthesis-shape.ts, and bump ART_VERSION.
 */
import "./lib-react-global";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEOM, GUM_PAD, festoon } from "../src/components/charts/dental/tooth-art";
import {
  ABUT_BOX,
  BASE_BOX,
  COL,
  IMPLANT_BOX,
  IMPLANT_DIA,
  IMPLANT_LEN,
  UNIT_BOTTOM,
  UNIT_PAD,
  UNIT_TOP,
  basePath,
  ridgePath,
} from "../src/components/charts/dental/prosthesis-shape";
import { bevel, clamp, distance, dot, gauss, hex, mix, noise, norm, normalAt, saveArt, shade, smooth, type RGB, type V3 } from "./lib-art";
import { renderGum } from "./lib-gum";
import { SOURCES, anatomyOf, boundary, load, sample, simplify, smoothPath, type Img, type Source } from "./lib-tooth-photos";

const OUT = join(process.cwd(), "public", "charts", "teeth");
const GEN = join(process.cwd(), "src", "components", "charts", "dental", "prosthesis-units.ts");
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "tooth-art");
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const { Y0, YE, GUM_TOP } = GEOM;
const C = COL / 2;
type Sheet = { name: string; w: number; h: number; px: Buffer };
const sheet: Sheet[] = [];

type Box = { x0: number; y0: number; x1: number; y1: number };

/** A picture from a function of position in chart units, 4×4 samples a pixel; null is empty. */
async function picture(name: string, box: Box, S: number, at: (x: number, y: number) => RGB | null): Promise<void> {
  const w = Math.round((box.x1 - box.x0) * S);
  const h = Math.round((box.y1 - box.y0) * S);
  const px = Buffer.alloc(w * h * 4);
  const N = 4;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const acc = [0, 0, 0];
      let a = 0;
      for (let v = 0; v < N; v++)
        for (let u = 0; u < N; u++) {
          const c = at(box.x0 + (i + (u + 0.5) / N) / S, box.y0 + (j + (v + 0.5) / N) / S);
          if (!c) continue;
          a++;
          for (let k = 0; k < 3; k++) acc[k] += c[k];
        }
      if (!a) continue;
      for (let k = 0; k < 3; k++) px[(j * w + i) * 4 + k] = Math.round(clamp(acc[k] / a) * 255);
      px[(j * w + i) * 4 + 3] = Math.round((a / (N * N)) * 255);
    }
  await sharp(px, { raw: { width: w, height: h, channels: 4 } })
    .webp({ quality: 90, alphaQuality: 95, effort: 6 })
    .toFile(join(OUT, `${name}.webp`));
  sheet.push({ name, w, h, px });
}

/* ── The teeth of a bridge ───────────────────────────────────────────────── */

const ramp = (stops: [number, string][]) => {
  const s = stops.map(([t, c]) => [t, hex(c)] as [number, RGB]);
  return (v: number): RGB => {
    if (v <= s[0][0]) return s[0][1];
    for (let i = 1; i < s.length; i++) if (v <= s[i][0]) return mix(s[i - 1][1], s[i][1], (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]));
    return s[s.length - 1][1];
  };
};
/** Glazed porcelain, from the shadows between two teeth to the light on a cusp. */
const PORCELAIN = ramp([
  [0.2, "#6b5f52"],
  [0.45, "#a39787"],
  [0.62, "#cbc1b4"],
  [0.76, "#e6ded3"],
  [0.86, "#f4eee6"],
  [0.94, "#fbf8f2"],
  [1, "#ffffff"],
]);

const US = 6;

/*
  The outline of a bridge tooth: half its width at heights from the neck to the
  biting edge. Every one reaches the edge of its column at the contact and
  nowhere else; below it the cusp or the edge is rounded the way a technician
  carves it, above it the crown narrows to its neck under the papilla.
*/
const PROFILE: Record<Source, [number, number][]> = {
  i1: [[58, 14.6], [62, 15.6], [67, 18.4], [73, 20.9], [80, 22.2], [86, 22.4], [92, 22.3], [96, 21.4], [98.4, 19.6], [99.6, 17], [100.2, 13]],
  i2: [[58, 14], [62, 15], [67, 18], [73, 20.7], [80, 22.2], [86, 22.4], [91, 22.1], [95.4, 20.6], [98, 18], [99.4, 14.6], [100, 10.5]],
  c: [[58, 14.4], [62, 15.4], [67, 18.4], [73, 21], [79, 22.4], [84, 22.2], [89, 20.2], [93, 16.6], [96.4, 12], [98.8, 7.4], [100.4, 3.4], [100.9, 1]],
  p: [[58, 14.8], [62, 15.8], [67, 18.8], [73, 21.2], [79, 22.4], [85, 22.3], [90, 20.6], [94, 17.2], [97, 13], [99, 8.6], [100.2, 4.6], [100.7, 1.4]],
  m: [[58, 16.6], [62, 17.6], [67, 19.9], [73, 21.6], [79, 22.4], [86, 22.4], [91, 21.6], [95, 19.8], [97.8, 17], [99.4, 13.6], [100.2, 10]],
};
/** A smooth curve through a profile's points (monotone between them, so it never bulges past a neighbour). */
function halfAt(pts: [number, number][], y: number): number {
  if (y <= pts[0][0]) return pts[0][1];
  const n = pts.length;
  if (y >= pts[n - 1][0]) return y > pts[n - 1][0] + 0.2 ? 0 : pts[n - 1][1];
  let i = 1;
  while (y > pts[i][0]) i++;
  const slope = (j: number) => (pts[j + 1][1] - pts[j][1]) / (pts[j + 1][0] - pts[j][0]);
  const tangent = (j: number) => {
    if (j === 0) return slope(0);
    if (j === n - 1) return slope(n - 2);
    const p = slope(j - 1);
    const q = slope(j);
    return p * q <= 0 ? 0 : (2 * p * q) / (p + q);
  };
  const [x0, y0] = pts[i - 1];
  const [x1, y1] = pts[i];
  const h = x1 - x0;
  const t = (y - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * tangent(i - 1) + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * tangent(i);
}

async function unit(src: Source): Promise<string> {
  const img: Img = await load(`upper-${src}.webp`);
  const an = anatomyOf(img);
  const crownH = an.bottom - an.cej;
  // Row by row, where the photographed crown's edges are.
  const L = new Float64Array(img.h).fill(-1);
  const R = new Float64Array(img.h).fill(-1);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      if (img.rgba[(y * img.w + x) * 4 + 3] < 0.8) continue;
      if (L[y] < 0) L[y] = x;
      R[y] = x;
    }
  const soft = (a: Float64Array, y: number) => {
    let s = 0;
    let n = 0;
    for (let k = -14; k <= 14; k++) {
      const yy = Math.round(clamp(y + k, 0, img.h - 1));
      if (a[yy] >= 0) {
        s += a[yy];
        n++;
      }
    }
    return n ? s / n : -1;
  };
  /*
    The photograph's enamel, from just inside the neck to just short of the
    biting edge: the outline is the bridge's (PROFILE), so the rows where the
    photographed cusps come apart are never sampled.
  */
  const first = an.cej + crownH * 0.04;
  const last = an.bottom - crownH * (src === "m" ? 0.13 : src === "p" ? 0.24 : src === "c" ? 0.1 : 0.05);
  const rowOf = (uy: number) => clamp(first + ((uy - Y0) / (YE - Y0)) * (last - first), first, last);
  // The photograph's own light, brought to one range, so five photographs make one bridge.
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let row = Math.round(first); row < last; row += 4) {
    const inset = (R[row] - L[row]) * 0.15;
    for (let x = Math.round(L[row] + inset); x < R[row] - inset; x += 3) {
      const i = (row * img.w + x) * 4;
      const a = img.rgba[i + 3] || 1;
      const l = (0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2]) / a;
      sum += l;
      sq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(sq / n - mean * mean) || 0.05;
  const k = Math.min(1.5, 0.1 / std);
  const prof = PROFILE[src];

  const at = (x: number, y: number): RGB | null => {
    if (y < Y0 - 3) return null;
    const W = halfAt(prof, y);
    const dx = Math.abs(x - C);
    if (dx > W) return null;
    // A molar's two cusps, and the groove between them.
    if (src === "m" && y > YE - 2.4 + 2.4 * smooth(0, 5.5, dx) + 0.4) return null;
    const row = rowOf(y);
    const l = soft(L, row);
    const r = soft(R, row);
    const f = (x - (C - W)) / (2 * W);
    const v = sample(img, l + (0.05 + f * 0.9) * (r - l), row);
    if (v[3] < 0.2) return null;
    const lum = (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / v[3];
    let t = clamp(0.875 + (lum - mean) * k, 0.2, 1);
    // Rounded toward the sides, the way a fused crown turns into its neighbour; a fine shadow on the joint itself.
    const side = dx / W;
    t *= 1 - 0.13 * Math.pow(smooth(0.55, 1, side), 1.4);
    if (y > Y0 + 8) t *= 1 - 0.36 * gauss(C - dx, 1.0) * (1 - smooth(YE - 12, YE - 4, y));
    // Shade under the gum's edge, and where the edge turns away.
    t *= 1 - 0.15 * (1 - smooth(Y0 - 2, Y0 + 5, y));
    const under = halfAt(prof, y + 1.1) < dx ? 1 : 0;
    t *= 1 - 0.07 * under;
    const c = PORCELAIN(t);
    // A little warmth at the neck, a little blue at the edge: porcelain is built up that way.
    const warm = 1 - smooth(Y0, Y0 + 15, y);
    const cool = smooth(YE - 9, YE, y);
    return [c[0] * (1 - 0.02 * cool), c[1] * (1 - 0.02 * warm - 0.006 * cool), c[2] * (1 - 0.06 * warm + 0.008 * cool)];
  };
  const box = { x0: -UNIT_PAD, y0: UNIT_TOP, x1: COL + UNIT_PAD, y1: UNIT_BOTTOM };
  await picture(`unit-${src}`, box, US, at);
  // Its outline, for the edge drawn round a span.
  const w = Math.round((box.x1 - box.x0) * US);
  const h = Math.round((box.y1 - box.y0) * US);
  const { px } = sheet[sheet.length - 1];
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  const local = smoothPath(simplify(boundary(mask, w, h), 1), US);
  // From the picture's corner to the column's.
  const num = (v: number) => v.toFixed(2).replace(/\.?0+$/, "");
  return local.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_m, x, y) => `${num(Number(x) - UNIT_PAD)} ${num(Number(y) + UNIT_TOP)}`);
}

/* ── Metal: a studio, and a lathe ────────────────────────────────────────── */

/** What polished metal sees in a direction: a soft box up on the left, a strip light on the right, a dark floor line. */
function studio(d: V3): number {
  let v = 0.42 + 0.22 * clamp(-d[1]);
  v += 1.25 * smooth(0.72, 0.95, dot(d, norm([-0.62, -0.42, 0.66])));
  v += 0.75 * smooth(0.5, 0.62, d[0]) * (1 - smooth(0.72, 0.84, d[0])) * (0.6 + 0.4 * (1 - Math.abs(d[1])));
  v -= 0.34 * gauss(d[0] - 0.22, 0.16);
  v -= 0.3 * smooth(0.82, 1, d[0]);
  v -= 0.28 * smooth(0.86, 1, -d[0]);
  return clamp(v, 0.04, 1.8);
}

type Metal = { base: RGB; rough: number; gain?: number };

function metal(n: V3, m: Metal, ao: number): RGB {
  const r = norm([2 * n[2] * n[0], 2 * n[2] * n[1], 2 * n[2] * n[2] - 1]);
  // Blasted metal blurs what it sees: the sharp studio fades into a soft diffuse light.
  const blur = norm([r[0] * (1 - m.rough) + n[0] * m.rough, r[1] * (1 - m.rough) + n[1] * m.rough, r[2] * (1 - m.rough) + n[2] * m.rough]);
  const mirror = studio(r) * (1 - m.rough) + (0.45 + 0.4 * clamp(dot(blur, norm([-0.5, -0.5, 0.7])))) * m.rough;
  const gain = m.gain ?? 1;
  // Titanium sits in gum: a breath of pink comes back from the sides.
  const bounce = 0.1 * smooth(0.55, 1, Math.abs(n[0]));
  const out: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = m.base[i] * mirror * gain * ao;
  return [out[0] + bounce * 0.5 * ao, out[1] + bounce * 0.18 * ao, out[2] + bounce * 0.2 * ao];
}

const TITANIUM = hex("#c9ced6");
const BLASTED = hex("#b3b8c0");
const ANODISED = hex("#e2bd74");

/** A turned part: `R(y, th)` its radius at a height and an angle round its axis. What is seen at x, or null. */
function lathe(R: (y: number, th: number) => number, x: number, y: number): { n: V3; th: number } | null {
  const rmax = Math.max(R(y, -Math.PI / 2), R(y, Math.PI / 2), R(y, 0));
  if (rmax <= 0 || Math.abs(x) > rmax) return null;
  let th = Math.asin(clamp(x / rmax, -1, 1));
  for (let i = 0; i < 6; i++) {
    const r = R(y, th);
    if (r <= 0) return null;
    const s = x / r;
    if (Math.abs(s) > 1) {
      th = Math.sign(s) * (Math.PI / 2);
      if (Math.abs(x) > R(y, th)) return null;
      break;
    }
    th = Math.asin(s);
  }
  const e = 0.02;
  const r = R(y, th);
  const rt = (R(y, th + e) - R(y, th - e)) / (2 * e);
  const ry = (R(y + e, th) - R(y - e, th)) / (2 * e);
  const dth: V3 = [rt * Math.sin(th) + r * Math.cos(th), 0, rt * Math.cos(th) - r * Math.sin(th)];
  const dy: V3 = [ry * Math.sin(th), 1, ry * Math.cos(th)];
  let n = norm([dth[1] * dy[2] - dth[2] * dy[1], dth[2] * dy[0] - dth[0] * dy[2], dth[0] * dy[1] - dth[1] * dy[0]]);
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  return { n, th };
}

const frac = (v: number) => v - Math.floor(v);

async function implant() {
  const Rmax = IMPLANT_DIA / 2;
  const L = IMPLANT_LEN;
  // Down the implant: 0 at the platform, 1 at the tip.
  const core = (t: number) => {
    if (t < 0.1) return Rmax * 0.965;
    const taper = Rmax * (0.95 - 0.36 * Math.pow((t - 0.1) / 0.9, 1.25));
    // The tip is rounded, not cut.
    return taper * Math.sqrt(Math.max(0, 1 - Math.pow(clamp((t - 0.9) / 0.1), 2.4)));
  };
  /** A buttress thread: a flat crest, a steep flank above it and a long one below. */
  const thread = (f: number) => smooth(0.02, 0.2, f) * (1 - smooth(0.42, 0.92, f));
  const pitch = 3.05;
  const R = (y: number, th: number) => {
    const t = -y / L;
    if (t < -0.02 || t >= 1) return 0;
    let r = core(t);
    if (t > 0.1) {
      // Fine threads under the collar, then the deep ones that hold the bone.
      const micro = smooth(0.1, 0.12, t) * (1 - smooth(0.24, 0.27, t));
      r += 0.28 * micro * Math.max(0, Math.sin((frac(-y / 1.02 + th / (2 * Math.PI)) - 0.25) * 2 * Math.PI) * 0.5 + 0.5);
      const deep = smooth(0.25, 0.31, t) * (1 - smooth(0.93, 0.985, t));
      const depth = 1.15 + 0.55 * smooth(0.3, 0.75, t);
      r += depth * deep * (thread(frac(-y / pitch + th / (2 * Math.PI))) - 0.12);
    }
    // The cutting flutes at the tip.
    if (t > 0.74) {
      const flute = gauss(th - 0.52, 0.2) * smooth(0.74, 0.8, t) * (1 - smooth(0.97, 1, t));
      r -= 1.5 * flute;
    }
    return Math.max(r, 0);
  };
  const at = (x: number, y: number): RGB | null => {
    if (y > 0.9) return null;
    const yy = Math.min(y, -0.01);
    const hit = lathe(R, x, yy);
    if (!hit) return null;
    const t = -y / L;
    const r = R(yy, hit.th);
    // How deep in the thread: the valleys see less of the room.
    const valley = t > 0.25 ? clamp((core(t) + 0.9 - r) / 1.5) : 0;
    const edge = 1 - 0.5 * smooth(0.86, 1, Math.abs(x) / Math.max(r, 0.1));
    const ao = (1 - 0.42 * valley) * edge;
    const polished = 1 - smooth(0.075, 0.105, t);
    const speck = (noise(x * 9, y * 9, 61) - 0.5) * 0.05 * (1 - polished);
    const c = metal(hit.n, polished > 0.5 ? { base: TITANIUM, rough: 0.12, gain: 1.02 } : { base: BLASTED, rough: 0.5, gain: 1.5 }, ao);
    return [c[0] + speck, c[1] + speck, c[2] + speck];
  };
  await picture("implant", { x0: -IMPLANT_BOX.x, y0: -IMPLANT_BOX.up, x1: IMPLANT_BOX.x, y1: IMPLANT_BOX.down }, 10, at);
}

async function abutments() {
  const Rp = IMPLANT_DIA / 2;
  const box = { x0: -ABUT_BOX.x, y0: -ABUT_BOX.up, x1: ABUT_BOX.x, y1: ABUT_BOX.down };
  const curve = (pts: [number, number][]) => (y: number) => {
    if (y < pts[0][0] || y > pts[pts.length - 1][0]) return 0;
    for (let i = 1; i < pts.length; i++)
      if (y <= pts[i][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * smooth(pts[i - 1][0], pts[i][0], y);
    return 0;
  };
  const part = async (name: string, prof: (y: number) => number, of: (y: number) => Metal) =>
    picture(name, box, 10, (x, y) => {
      const hit = lathe((yy) => prof(yy), x, y);
      if (!hit) return null;
      return metal(hit.n, of(y), 1 - 0.45 * smooth(0.88, 1, Math.abs(x) / Math.max(prof(y), 0.1)));
    });
  const polished: Metal = { base: TITANIUM, rough: 0.08, gain: 1.08 };
  const gold: Metal = { base: ANODISED, rough: 0.12, gain: 1.05 };
  // A healing abutment: a polished dome through the gum.
  await part(
    "abut-heal",
    curve([
      [-0.8, Rp * 0.86],
      [2.2, Rp * 0.94],
      [7.6, Rp * 1.12],
      [9.4, Rp * 1.02],
      [10.6, Rp * 0.72],
      [11.1, Rp * 0.34],
    ]),
    () => polished
  );
  // A multi-unit abutment: the anodised collar, and the cone a bridge is screwed to.
  await part(
    "abut-multi",
    curve([
      [-0.8, Rp * 0.8],
      [1.6, Rp * 0.9],
      [4.6, Rp * 1.0],
      [5.2, Rp * 1.0],
      [5.5, Rp * 0.8],
      [11.6, Rp * 0.5],
      [12.2, Rp * 0.44],
    ]),
    (y) => (y < 5.2 ? gold : polished)
  );
  // A crown's own abutment: a collar and a post.
  await part(
    "abut-post",
    curve([
      [-0.8, Rp * 0.82],
      [3.4, Rp * 1.02],
      [4.2, Rp * 1.0],
      [4.9, Rp * 0.74],
      [13, Rp * 0.5],
      [13.6, Rp * 0.36],
    ]),
    () => polished
  );

  // From above: the implant's own connection, and an abutment's.
  const top = async (name: string, heightAt: (r: number, a: number) => number, of: (r: number) => Metal, R: number) =>
    picture(name, { x0: -10, y0: -10, x1: 10, y1: 10 }, 10, (x, y) => {
      const r = Math.hypot(x, y);
      if (r > R) return null;
      const hAt = (xx: number, yy: number) => heightAt(Math.hypot(xx, yy), Math.atan2(yy, xx));
      const e = 0.06;
      const n = norm([-(hAt(x + e, y) - hAt(x - e, y)) / (2 * e), -(hAt(x, y + e) - hAt(x, y - e)) / (2 * e), 1]);
      const depth = clamp(-heightAt(r, Math.atan2(y, x)) / 4);
      return metal(n, of(r), (1 - 0.62 * depth) * (1 - 0.35 * smooth(R - 0.7, R, r)));
    });
  const hexR = (a: number, r0: number) => {
    const s = Math.PI / 3;
    const b = (((a % s) + s) % s) - s / 2;
    return (r0 * Math.cos(Math.PI / 6)) / Math.cos(b);
  };
  await top(
    "implant-top",
    (r, a) => {
      let v = -0.8 * smooth(Rp - 1, Rp, r);
      v -= 2.2 * (1 - smooth(Rp * 0.6, Rp * 0.72, r));
      v -= 1.8 * (1 - smooth(hexR(a, Rp * 0.46) - 0.25, hexR(a, Rp * 0.46) + 0.25, r));
      return v;
    },
    () => ({ base: TITANIUM, rough: 0.35, gain: 1.4 }),
    Rp
  );
  await top(
    "abut-top",
    (r, a) => {
      let v = 1.4 * (1 - smooth(Rp * 0.5, Rp * 0.8, r));
      v -= 0.9 * smooth(Rp * 0.94, Rp, r);
      v -= 3 * (1 - smooth(hexR(a, Rp * 0.22) - 0.2, hexR(a, Rp * 0.22) + 0.2, r));
      return v;
    },
    (r) => (r > Rp * 0.82 ? { base: ANODISED, rough: 0.4, gain: 1.5 } : { base: TITANIUM, rough: 0.3, gain: 1.4 }),
    Rp
  );
  await top(
    "heal-top",
    (r, a) => {
      let v = -2.6 * smooth(Rp * 0.5, Rp * 1.12, r);
      v -= 2.2 * (1 - smooth(hexR(a, Rp * 0.26) - 0.2, hexR(a, Rp * 0.26) + 0.2, r));
      return v;
    },
    () => ({ base: TITANIUM, rough: 0.32, gain: 1.42 }),
    Rp * 1.12
  );
}

/* ── The pink base ───────────────────────────────────────────────────────── */

const PINK_HIGH = hex("#d66c76");
const PINK = hex("#ec979a");
const PINK_RIM = hex("#f6b6b1");

async function base(arch: "upper" | "lower", kind: "mid" | "left" | "right" | "one") {
  const S = 6;
  const P = UNIT_PAD; // a sliver of each neighbour, so tiles overlap
  const w = COL * S;
  const wo = (COL + 2 * P) * S;
  const h = (BASE_BOX.bottom - BASE_BOX.top) * S;
  const l = kind === "left" || kind === "one" ? "end" : "join";
  const r = kind === "right" || kind === "one" ? "end" : "join";
  const W3 = w * 3;
  const cv = createCanvas(W3, h);
  const g = cv.getContext("2d");
  g.fillStyle = "#000";
  const put = (k: number, d: string) => {
    g.setTransform(S, 0, 0, S, k * w, -BASE_BOX.top * S);
    g.fill(new Path2D(d));
  };
  if (l === "join") put(0, basePath("join", "join"));
  put(1, basePath(l, r));
  if (r === "join") put(2, basePath("join", "join"));
  const data = g.getImageData(0, 0, W3, h).data;
  const cov3 = new Float32Array(W3 * h);
  const alpha = (x: number, y: number) => data[(y * W3 + x) * 4 + 3] / 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < W3; x++) {
      let a = alpha(x, y);
      // Where two columns meet, the canvas leaves a hairline: close it.
      if ((x % w === 0 || x % w === w - 1) && x > 0 && x < W3 - 1) a = Math.max(a, Math.min(alpha(x - 1, y), alpha(x + 1, y)));
      cov3[y * W3 + x] = a;
    }
  const d3 = distance(cov3, W3, h);
  const hf = new Float32Array(wo * h);
  const cov = new Float32Array(wo * h);
  const dist = new Float32Array(wo * h);
  const off = w - P * S;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < wo; x++) {
      const j = y * W3 + (x + off);
      const i = y * wo + x;
      cov[i] = cov3[j];
      dist[i] = d3[j];
      if (cov3[j] <= 0) continue;
      const ux = x / S - P;
      const uy = BASE_BOX.top + y / S;
      let v = bevel(d3[j], 5.2 * S) * 1.05;
      // Acrylic is waxed up like gum: a swelling over each root, a hollow between, a light stipple.
      v += 2.1 * S * 0.4 * Math.cos(((ux - C) / COL) * Math.PI * 2) * smooth(46, 56, uy) * (1 - smooth(58, 64, uy));
      v += 0.75 * (noise((ux * 75) / COL, uy * 1.7, 71, 75) - 0.5) * smooth(48, 56, uy);
      v += 0.35 * (noise((ux * 194) / COL, uy * 4.4, 73, 194) - 0.5);
      hf[i] = v;
    }
  const color = (x: number, y: number): RGB => {
    const i = y * wo + x;
    const uy = BASE_BOX.top + y / S;
    let a = mix(PINK_HIGH, PINK, smooth(45, 56, uy));
    a = mix(a, PINK_RIM, (1 - smooth(0, 2.4 * S, dist[i])) * smooth(56, 62, uy));
    const m = (noise(((x / S - P) * 22) / COL, uy * 0.5, 81, 22) - 0.5) * 0.06;
    const n = normalAt(hf, wo, h, x, y, 1);
    const c = shade(n, { albedo: [a[0] + m, a[1] + m * 0.6, a[2] + m * 0.6], gloss: 0.78, wrap: 0.5, ao: 1 }, arch === "lower");
    const rim = 1 - 0.26 * (1 - smooth(0, 1.1 * S, dist[i]));
    return [c[0] * rim, c[1] * rim * 0.97, c[2] * rim * 0.97];
  };
  const name = `base-${arch === "upper" ? "u" : "l"}-${kind}`;
  const px = await saveArt(OUT, name, wo, h, [{ cov, color }]);
  sheet.push({ name, w: wo, h, px });
}

/* ── Healed gum ──────────────────────────────────────────────────────────── */
async function ridge(arch: "upper" | "lower", leftGone: boolean, rightGone: boolean) {
  const T = GUM_TOP - 40;
  const name = `ridge-${arch === "upper" ? "u" : "l"}-${leftGone ? 1 : 0}${rightGone ? 1 : 0}`;
  const g = await renderGum(
    OUT,
    name,
    arch,
    [leftGone ? ridgePath(true, true, T) : festoon(T), ridgePath(leftGone, rightGone, T), rightGone ? ridgePath(true, true, T) : festoon(T)],
    0.1
  );
  sheet.push({ name, w: g.w, h: 104 * 5, px: g.px });
}

async function main() {
  const outlines: string[] = [];
  for (const s of SOURCES) outlines.push(`  ${s}: ${JSON.stringify(await unit(s))},`);
  await implant();
  await abutments();
  for (const a of ["upper", "lower"] as const) {
    for (const k of ["mid", "left", "right", "one"] as const) await base(a, k);
    for (const l of [false, true]) for (const r of [false, true]) await ridge(a, l, r);
  }
  writeFileSync(
    GEN,
    `/*
  Generated by scripts/render-prosthesis-art.tsx — do not edit by hand.

  The outline of each bridge tooth's picture, in tooth-local units, for the
  edge drawn round a span. Keys are the photograph a tooth is drawn from.
*/

export const UNIT_OUTLINES: Record<"i1" | "i2" | "c" | "p" | "m", string> = {
${outlines.join("\n")}
};
`
  );
  console.log(`baked ${sheet.length} pictures into public/charts/teeth`);
  const cols = 8;
  const cellW = Math.round((COL + 2 * GUM_PAD) * 6 + 40);
  const cellH = 560;
  const rows = Math.ceil(sheet.length / cols);
  const parts = await Promise.all(sheet.map((p) => sharp(p.px, { raw: { width: p.w, height: p.h, channels: 4 } }).png().toBuffer()));
  await sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 246, g: 246, b: 248, alpha: 1 } } })
    .composite(parts.map((input, k) => ({ input, left: (k % cols) * cellW + 10, top: Math.floor(k / cols) * cellH + 10 })))
    .png()
    .toFile(join(SHOTS, "prosthesis-sprites.png"));
  console.log("contact sheet: scripts/qa-shots/tooth-art/prosthesis-sprites.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
