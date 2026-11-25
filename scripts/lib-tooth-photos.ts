/**
 * The tooth photographs, read: loading one, finding its neck, sampling it, and
 * tracing a picture into an outline. Shared by bake-tooth-photos.tsx (the
 * chart's own teeth) and render-prosthesis-art.tsx (the teeth of a bridge).
 */
import sharp from "sharp";
import { join } from "node:path";

export const ART = join(process.cwd(), "scripts", "art", "teeth");
export const SOURCES = ["i1", "i2", "c", "p", "m"] as const;
export type Source = (typeof SOURCES)[number];

export type Img = { w: number; h: number; rgba: Float32Array }; // premultiplied, 0..1

export async function load(name: string): Promise<Img> {
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
export type Anatomy = { top: number; bottom: number; cej: number; crownL: number; crownR: number };

/**
 * The enamel is white with a cool cast; the root is ivory, yellower. Row by
 * row, how yellow the tooth is rises sharply where one meets the other: that
 * row is the neck. The crown (at the bottom: these are upper teeth) runs from
 * there to the biting edge.
 */
export function anatomyOf(img: Img): Anatomy {
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

export function sample(img: Img, x: number, y: number): [number, number, number, number] {
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

export type Pt = [number, number];

/** The outer boundary of a mask, as pixel corners, by following its edge (Moore neighbourhood). */
export function boundary(mask: Uint8Array, w: number, h: number): Pt[] {
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
export function simplify(pts: Pt[], eps: number): Pt[] {
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
export function smoothPath(pts: Pt[], S: number): string {
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
