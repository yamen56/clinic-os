/**
 * The dental chart's teeth, from photographs.
 *
 * Yamen, 2026-11-03: "did not like it … make it realistic but in the same time
 * make sure it is good looking and someone get impressed when seeing it" — and
 * he chose the photo-real look of the face chart over a drawn one. The teeth are
 * photo-real renders (Canva, the face chart's source), one per kind of tooth,
 * kept in scripts/art/teeth/ with their backgrounds cut away.
 *
 * Each chart tooth gets its picture fitted to its place in the chart: the crown
 * from the gum line (Y0) to the biting edge (YE) and as wide as the tooth's
 * column allows, the root above it. The picture's own outline, root tips and
 * canals are then traced into tooth-photos.ts, so a crown, a filling, a root
 * canal or an implant drawn on the chart follows the photographed tooth, not a
 * drawn one.
 *
 *   npx tsx scripts/bake-tooth-photos.tsx [--import <canva-row.png>]
 *     → public/charts/teeth/side-*.webp
 *     → src/components/charts/dental/tooth-photos.ts
 *
 * --import cuts the five photographs out of one Canva export (five 1024×1536
 * tiles side by side on white: upper central incisor, lateral, canine,
 * premolar, first molar) into scripts/art/teeth/. The lower teeth, the second
 * and third molars and the baby molars are drawn from these until photographs
 * of their own are made.
 */
import "./lib-react-global";
import sharp from "sharp";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tooth, PERMANENT_UPPER, PERMANENT_LOWER, PRIMARY_UPPER, PRIMARY_LOWER, type Tooth } from "../src/lib/charts/dental/teeth";
import { CW, SIDE_H, GEOM, drawnShape as shapeOf, sideArtKey } from "../src/components/charts/dental/tooth-art";

const ART = join(process.cwd(), "scripts", "art", "teeth");
const OUT = join(process.cwd(), "public", "charts", "teeth");
const GEN = join(process.cwd(), "src", "components", "charts", "dental", "tooth-photos.ts");
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "tooth-art");
mkdirSync(ART, { recursive: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const { C, Y0, YE } = GEOM;
const S = 5; // sprite pixels per chart unit
const SOURCES = ["i1", "i2", "c", "p", "m"] as const;
type Source = (typeof SOURCES)[number];

type Img = { w: number; h: number; rgba: Float32Array }; // premultiplied, 0..1
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/* ── Import: cut the photographs out of the Canva export ─────────────────── */
async function importRow(file: string) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const tileW = Math.round(W / SOURCES.length);
  for (let k = 0; k < SOURCES.length; k++) {
    const x0 = k * tileW;
    const w = tileW;
    const h = H;
    // How far from white each pixel is: the background is white, and the tooth never quite is.
    const dark = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * W + x0 + x) * 3;
        dark[y * w + x] = 255 - Math.min(data[i], data[i + 1], data[i + 2]);
      }
    // Background: everything near-white that the tile's border can reach.
    const bg = new Uint8Array(w * h);
    const stack: number[] = [];
    const seed = (x: number, y: number) => {
      const j = y * w + x;
      if (!bg[j] && dark[j] <= 7) {
        bg[j] = 1;
        stack.push(j);
      }
    };
    for (let x = 0; x < w; x++) {
      seed(x, 0);
      seed(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      seed(0, y);
      seed(w - 1, y);
    }
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w;
      const y = (j - x) / w;
      if (x > 0) seed(x - 1, y);
      if (x < w - 1) seed(x + 1, y);
      if (y > 0) seed(x, y - 1);
      if (y < h - 1) seed(x, y + 1);
    }
    // Alpha: solid inside; at the rim, from how far the pixel is from white — then the white taken back out of its colour.
    const out = Buffer.alloc(w * h * 4);
    let minX = w,
      minY = h,
      maxX = 0,
      maxY = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const j = y * w + x;
        const nearBg = bg[j] || (x > 0 && bg[j - 1]) || (x < w - 1 && bg[j + 1]) || (y > 0 && bg[j - w]) || (y < h - 1 && bg[j + w]);
        const a = bg[j] ? 0 : nearBg ? clamp((dark[j] - 4) / 22) : 1;
        if (a <= 0) continue;
        const i = (y * W + x0 + x) * 3;
        for (let c = 0; c < 3; c++) out[j * 4 + c] = Math.round(clamp((data[i + c] / 255 - (1 - a)) / a) * 255);
        out[j * 4 + 3] = Math.round(a * 255);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    const pad = 4;
    await sharp(out, { raw: { width: w, height: h, channels: 4 } })
      .extract({ left: Math.max(0, minX - pad), top: Math.max(0, minY - pad), width: Math.min(w, maxX - minX + 1 + 2 * pad), height: Math.min(h, maxY - minY + 1 + 2 * pad) })
      .webp({ lossless: true })
      .toFile(join(ART, `upper-${SOURCES[k]}.webp`));
    console.log(`imported upper-${SOURCES[k]}.webp`);
  }
}

async function load(name: string): Promise<Img> {
  const { data, info } = await sharp(join(ART, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Float32Array(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const a = data[i * 4 + 3] / 255;
    rgba[i * 4] = (data[i * 4] / 255) * a;
    rgba[i * 4 + 1] = (data[i * 4 + 1] / 255) * a;
    rgba[i * 4 + 2] = (data[i * 4 + 2] / 255) * a;
    rgba[i * 4 + 3] = a;
  }
  return { w: info.width, h: info.height, rgba };
}

/* ── Where the crown ends and the root begins ────────────────────────────── */
type Anatomy = { top: number; bottom: number; cej: number; crownL: number; crownR: number };

/**
 * The enamel is white with a cool cast; the root is ivory, yellower. Row by
 * row, how yellow the tooth is rises sharply where one meets the other: that
 * row is the neck. The crown (at the bottom: these are upper teeth) runs from
 * there to the biting edge.
 */
function anatomyOf(img: Img): Anatomy {
  const { w, h, rgba } = img;
  let top = h,
    bottom = 0;
  const yellow: number[] = new Array(h).fill(NaN);
  const width: number[] = new Array(h).fill(0);
  const left: number[] = new Array(h).fill(w);
  const right: number[] = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    let sum = 0,
      n = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3];
      if (a < 0.5) continue;
      const r = rgba[i] / a,
        g = rgba[i + 1] / a,
        b = rgba[i + 2] / a;
      sum += (r + g) / 2 - b;
      n++;
      left[y] = Math.min(left[y], x);
      right[y] = Math.max(right[y], x);
    }
    if (n) {
      yellow[y] = sum / n;
      width[y] = right[y] - left[y];
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  // Smooth, then find the steepest fall in yellowness going down from the middle of the tooth.
  const sm = yellow.map((_, y) => {
    let s = 0,
      n = 0;
    for (let k = -6; k <= 6; k++) {
      const v = yellow[y + k];
      if (Number.isFinite(v)) {
        s += v;
        n++;
      }
    }
    return n ? s / n : NaN;
  });
  const from = Math.round(top + (bottom - top) * 0.35);
  const to = Math.round(top + (bottom - top) * 0.85);
  let cej = Math.round(top + (bottom - top) * 0.6);
  let steep = 0;
  for (let y = from; y < to; y++) {
    const d = sm[y - 8] - sm[y + 8];
    if (d > steep) {
      steep = d;
      cej = y;
    }
  }
  let crownL = w,
    crownR = 0;
  for (let y = cej; y <= bottom; y++) {
    if (!width[y]) continue;
    crownL = Math.min(crownL, left[y]);
    crownR = Math.max(crownR, right[y]);
  }
  return { top, bottom, cej, crownL, crownR };
}

/* ── Fitting a photograph to a tooth's place on the chart ────────────────── */
function sample(img: Img, x: number, y: number): [number, number, number, number] {
  const { w, h, rgba } = img;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return [0, 0, 0, 0];
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1),
    y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0,
    fy = y - y0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const a = rgba[(y0 * w + x0) * 4 + c],
      b = rgba[(y0 * w + x1) * 4 + c],
      d = rgba[(y1 * w + x0) * 4 + c],
      e = rgba[(y1 * w + x1) * 4 + c];
    out[c] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
  }
  return out;
}

type Fit = { sprite: Float32Array; w: number; h: number };

function fit(img: Img, an: Anatomy, t: Tooth): Fit {
  const s = shapeOf(t);
  const w = CW * S;
  const h = SIDE_H * S;
  const crownH = an.bottom - an.cej;
  const crownW = an.crownR - an.crownL;
  const cx = (an.crownL + an.crownR) / 2;
  const sx = (2 * s.mw * S) / crownW;
  const syc = ((YE - Y0) * S) / crownH;
  /*
    The root: as long as this tooth's root is (the drawn proportions' apex),
    whatever the photograph's own proportion. A canine's root is half as long
    again as its crown; the photograph's was barely as long, and on the chart
    the longest root in the mouth came out the shortest.
  */
  const rootH = an.cej - an.top;
  const syr = ((Y0 - s.apex) * S) / rootH;
  const sprite = new Float32Array(w * h * 4);
  const SS = 3; // 3×3 samples a pixel: the photograph is two to three times the sprite's size
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      for (let j = 0; j < SS; j++)
        for (let i = 0; i < SS; i++) {
          const px = x + (i + 0.5) / SS;
          const py = y + (j + 0.5) / SS;
          const srcY = py >= Y0 * S ? an.cej + (py - Y0 * S) / syc : an.cej - (Y0 * S - py) / syr;
          const srcX = cx + (px - C * S) / sx;
          const v = sample(img, srcX, srcY);
          for (let c = 0; c < 4; c++) acc[c] += v[c];
        }
      for (let c = 0; c < 4; c++) sprite[(y * w + x) * 4 + c] = acc[c] / (SS * SS);
    }
  if (t.primary) {
    // A baby tooth: whiter and more opaque than a grown one.
    for (let i = 0; i < w * h; i++) {
      const a = sprite[i * 4 + 3];
      if (!a) continue;
      for (let c = 0; c < 3; c++) sprite[i * 4 + c] = sprite[i * 4 + c] * 0.88 + a * 0.12;
    }
  }
  return { sprite, w, h };
}

/* ── Tracing the fitted picture's outline ────────────────────────────────── */
type Pt = [number, number];

/** The outer boundary of a mask, as pixel corners, by following its edge (Moore neighbourhood). */
function boundary(mask: Uint8Array, w: number, h: number): Pt[] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  let sx = -1,
    sy = -1;
  outer: for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (at(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
  if (sx < 0) return [];
  const dirs: Pt[] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const pts: Pt[] = [[sx, sy]];
  let cx = sx,
    cy = sy,
    d = 6; // came from above
  for (let step = 0; step < w * h * 4; step++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8; // start left of where we came from
      const nx = cx + dirs[nd][0];
      const ny = cy + dirs[nd][1];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        d = nd;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (cx === sx && cy === sy) break;
    pts.push([cx, cy]);
  }
  return pts;
}

/** Ramer–Douglas–Peucker, closed. */
function simplify(pts: Pt[], eps: number): Pt[] {
  const rdp = (a: number, b: number, out: Pt[]) => {
    let best = 0,
      idx = -1;
    const [x1, y1] = pts[a];
    const [x2, y2] = pts[b];
    const dx = x2 - x1,
      dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > best) {
        best = d;
        idx = i;
      }
    }
    if (best > eps && idx > 0) {
      rdp(a, idx, out);
      rdp(idx, b, out);
    } else out.push(pts[b]);
  };
  if (pts.length < 4) return pts;
  const mid = Math.floor(pts.length / 2);
  const out: Pt[] = [pts[0]];
  rdp(0, mid, out);
  rdp(mid, pts.length - 1, out);
  return out;
}

/** A smooth closed path through the points (Catmull-Rom as cubic Béziers), in chart units. */
function smoothPath(pts: Pt[]): string {
  const p = pts.map(([x, y]) => [(x + 0.5) / S, (y + 0.5) / S] as Pt);
  const n = p.length;
  const f = (v: number) => v.toFixed(2).replace(/\.?0+$/, "");
  let d = `M ${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n],
      p1 = p[i],
      p2 = p[(i + 1) % n],
      p3 = p[(i + 2) % n];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + " Z";
}

type Geometry = {
  crown: string;
  root: string;
  nw: number;
  mw: number;
  apex: number;
  apices: Pt[];
  canals: [number, number, number, number][];
  furcation?: Pt;
};

function trace(f: Fit): Geometry {
  const { sprite, w, h } = f;
  const solid = (x: number, y: number) => sprite[(y * w + x) * 4 + 3] >= 0.5;
  const crownMask = new Uint8Array(w * h);
  const rootMask = new Uint8Array(w * h);
  const cut = Math.round((Y0 - 2) * S);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue;
      if (y >= cut) crownMask[y * w + x] = 1;
      if (y < Math.round(Y0 * S) + S) rootMask[y * w + x] = 1;
    }
  const crown = smoothPath(simplify(boundary(crownMask, w, h), 0.9));
  const root = smoothPath(simplify(boundary(rootMask, w, h), 0.9));

  // Widths, at the neck and at the crown's fullest.
  const span = (y: number) => {
    let l = w,
      r = -1;
    for (let x = 0; x < w; x++)
      if (solid(x, y)) {
        l = Math.min(l, x);
        r = Math.max(r, x);
      }
    return r < 0 ? 0 : (r - l + 1) / S;
  };
  const nw = span(Math.round(Y0 * S)) / 2;
  let mw = 0;
  for (let y = Math.round(Y0 * S); y < h; y++) mw = Math.max(mw, span(y) / 2);

  // The root tips: the highest points of the root's outline, a tip each, with a hollow between.
  const topY = new Array(w).fill(Infinity);
  for (let x = 0; x < w; x++)
    for (let y = 0; y < Y0 * S; y++)
      if (solid(x, y)) {
        topY[x] = y;
        break;
      }
  const tips: Pt[] = [];
  const R = 3 * S;
  for (let x = 0; x < w; x++) {
    if (!Number.isFinite(topY[x])) continue;
    let isMin = true;
    for (let k = -R; k <= R && isMin; k++) if (k && x + k >= 0 && x + k < w && topY[x + k] < topY[x]) isMin = false;
    if (!isMin) continue;
    if (tips.length && Math.abs(tips[tips.length - 1][0] - x) < R) continue; // a flat tip, counted once
    tips.push([x, topY[x]]);
  }
  // Keep tips separated by a real hollow (a furcation), not a ripple on one root.
  const apicesPx: Pt[] = [];
  for (const tp of tips) {
    const prev = apicesPx[apicesPx.length - 1];
    if (!prev) {
      apicesPx.push(tp);
      continue;
    }
    let valley = -Infinity;
    for (let x = prev[0]; x <= tp[0]; x++) if (Number.isFinite(topY[x])) valley = Math.max(valley, topY[x]);
    if (valley - Math.max(prev[1], tp[1]) > 8 * S) apicesPx.push(tp);
    else if (tp[1] < prev[1]) apicesPx[apicesPx.length - 1] = tp;
  }
  const apices = apicesPx.slice(0, 3).map(([x, y]) => [x / S, y / S] as Pt);
  let furcation: Pt | undefined;
  if (apicesPx.length >= 2) {
    let vx = apicesPx[0][0],
      vy = -Infinity;
    for (let x = apicesPx[0][0]; x <= apicesPx[1][0]; x++)
      if (Number.isFinite(topY[x]) && topY[x] > vy) {
        vy = topY[x];
        vx = x;
      }
    furcation = [vx / S, vy / S];
  }
  const canals = apices.map(([ax, ay]) => [C + (ax - C) * 0.25, Y0 + 4, ax, ay + 4] as [number, number, number, number]);
  const apex = Math.min(...apices.map(([, y]) => y));
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    crown,
    root,
    nw: r2(nw),
    mw: r2(mw),
    apex: r2(apex),
    apices: apices.map(([x, y]) => [r2(x), r2(y)]),
    canals: canals.map((c) => c.map(r2) as [number, number, number, number]),
    furcation: furcation ? [r2(furcation[0]), r2(furcation[1])] : undefined,
  };
}

/* ── Which photograph each chart tooth is drawn from ─────────────────────── */
function sourceOf(t: Tooth): Source {
  if (t.kind === "incisor") return t.arch === "upper" && t.position === 1 ? "i1" : "i2";
  if (t.kind === "canine") return "c";
  // A lower premolar seen from the cheek is a smaller canine: one root, one tall cusp.
  if (t.kind === "premolar") return t.arch === "upper" ? "p" : "c";
  if (t.primary && t.position === 4) return t.arch === "upper" ? "p" : "c";
  return "m";
}

async function main() {
  const at = process.argv.indexOf("--import");
  if (at > 0) await importRow(process.argv[at + 1]);
  for (const s of SOURCES) if (!existsSync(join(ART, `upper-${s}.webp`))) throw new Error(`missing scripts/art/teeth/upper-${s}.webp — run with --import`);
  const imgs = new Map<Source, { img: Img; an: Anatomy }>();
  for (const s of SOURCES) {
    const img = await load(`upper-${s}.webp`);
    const an = anatomyOf(img);
    imgs.set(s, { img, an });
    console.log(`${s}: ${img.w}×${img.h}, neck at ${Math.round(((an.cej - an.top) / (an.bottom - an.top)) * 100)}% down`);
  }

  const all = [...PERMANENT_UPPER, ...PERMANENT_LOWER, ...PRIMARY_UPPER, ...PRIMARY_LOWER].map(tooth);
  const done = new Map<string, Geometry>();
  const sheet: { name: string; px: Buffer }[] = [];
  for (const t of all) {
    const key = sideArtKey(t);
    if (done.has(key)) continue;
    const { img, an } = imgs.get(sourceOf(t))!;
    const f = fit(img, an, t);
    const px = Buffer.alloc(f.w * f.h * 4);
    for (let i = 0; i < f.w * f.h; i++) {
      const a = f.sprite[i * 4 + 3];
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(clamp(f.sprite[i * 4 + c] / a) * 255);
      px[i * 4 + 3] = Math.round(clamp(a) * 255);
    }
    await sharp(px, { raw: { width: f.w, height: f.h, channels: 4 } }).webp({ quality: 90, alphaQuality: 95, effort: 6 }).toFile(join(OUT, `side-${key}.webp`));
    done.set(key, trace(f));
    sheet.push({ name: key, px });
  }

  const lines = [...done.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, g]) => `  ${JSON.stringify(k)}: ${JSON.stringify(g)},`);
  writeFileSync(
    GEN,
    `/*
  Generated by scripts/bake-tooth-photos.tsx — do not edit by hand.

  Each chart tooth's photograph, as the chart needs to draw on it: the crown's
  and the root's outlines, the widths at the neck (nw) and the crown's fullest
  (mw), the root tips and the canals to them, in tooth-local units (a 44-wide
  column, 104 tall, drawn as an upper tooth). Keys are sideArtKey().
*/

export type PhotoGeometry = {
  crown: string;
  root: string;
  nw: number;
  mw: number;
  apex: number;
  apices: [number, number][];
  canals: [number, number, number, number][];
  furcation?: [number, number];
};

export const TOOTH_PHOTOS: Record<string, PhotoGeometry> = {
${lines.join("\n")}
};
`
  );
  console.log(`baked ${done.size} teeth; geometry → src/components/charts/dental/tooth-photos.ts`);

  // A contact sheet, with each traced outline drawn over its picture.
  const cellW = CW * S + 20;
  const cellH = SIDE_H * S + 20;
  const cols = 9;
  const rows = Math.ceil(sheet.length / cols);
  const parts = await Promise.all(
    sheet.map(async (p) => {
      const g = done.get(p.name)!;
      const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${CW * S}" height="${SIDE_H * S}" viewBox="0 0 ${CW} ${SIDE_H}"><path d="${g.crown}" fill="none" stroke="#2463cf" stroke-width="0.35"/><path d="${g.root}" fill="none" stroke="#d6336c" stroke-width="0.3"/>${g.apices.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.9" fill="#d6336c"/>`).join("")}</svg>`
      );
      return sharp(p.px, { raw: { width: CW * S, height: SIDE_H * S, channels: 4 } })
        .composite([{ input: svg }])
        .png()
        .toBuffer();
    })
  );
  await sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(parts.map((input, k) => ({ input, left: (k % cols) * cellW + 10, top: Math.floor(k / cols) * cellH + 10 })))
    .png()
    .toFile(join(SHOTS, "photos.png"));
  console.log("contact sheet: scripts/qa-shots/tooth-art/photos.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
