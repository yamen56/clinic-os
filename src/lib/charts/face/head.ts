/**
 * Where a dot on one face picture is on the others.
 *
 * Yamen, 2026-11-08: "when I put the dot on one place it should be accurate and
 * in the spot exactly, and not show in the other spot — if I put something on
 * the left ear it should not disturb my work on the right ear."
 *
 * The five pictures are one head, seen from five sides (scripts/bake-face-head.ts
 * fits it to them). A dot is a spot on that head's skin: where around the head
 * it is, and how high. Another picture draws it where that spot is on it, and
 * only when that skin faces it, so the left ear's dots are never on the right
 * profile and a dot beside the nose stays beside the nose. Each turned picture
 * bends the head a little to meet its own eyes, nose, mouth and chin. The ears
 * stand out from the head and are matched by their own outline.
 *
 * A dot is kept as it was tapped (its picture and place on it), so nothing stored
 * changes when the fit is improved.
 */

import type { FaceView } from "./catalog";
import { HEAD_EAR, HEAD_FIT, HEAD_SLICES, HEAD_VIEWS } from "./head-data";

type Pt = { x: number; y: number };
const DEG = Math.PI / 180;
/** The pictures' width over their height (945 × 1264): the head is measured across in widths. */
const ASPECT = 945 / 1264;

type Fit = { s2: number; c: [number, number, number][]; dx: number[]; dy: number[] };
type Ear = { side: "l" | "r"; bowl: Pt; rim: Pt[] };
type View = { psi: number; c: number; k: number; v: readonly (readonly number[])[]; fit: Fit | null; ears: Ear[] };

const flip = (p: Pt): Pt => ({ x: 1 - p.x, y: p.y });

function earOf(side: "l" | "r", pts: [number, number][], mirror: boolean): Ear {
  const all = pts.map(([x, y]) => (mirror ? flip({ x, y }) : { x, y }));
  return { side, bowl: all[0], rim: all.slice(1) };
}

function view(base: "front" | "left" | "front_left", mirror: boolean): View {
  const s = HEAD_VIEWS[base];
  const f = base === "front" ? null : HEAD_FIT[base];
  return {
    psi: (mirror ? -s.psi : s.psi) * DEG,
    c: mirror ? 1 - s.c : s.c,
    k: s.k,
    v: s.v,
    fit: f && {
      s2: 2 * f.sigma * f.sigma,
      c: f.c.map(([X, Y, Z]) => [mirror ? -X : X, Y, Z]),
      dx: f.dx.map((d) => (mirror ? -d : d)),
      dy: f.dy,
    },
    ears: base === "front" ? [earOf("l", HEAD_EAR.front, false), earOf("r", HEAD_EAR.front, true)] : [earOf(mirror ? "r" : "l", HEAD_EAR[base], mirror)],
  };
}

const VIEWS: Record<FaceView, View> = {
  front: view("front", false),
  front_left: view("front_left", false),
  left: view("left", false),
  front_right: view("front_left", true),
  right: view("left", true),
};

/* ── The head ─────────────────────────────────────────────────────────────── */

const { y0: Y0, dy: DY, s: SLICES } = HEAD_SLICES;
const YMAX = Y0 + DY * (SLICES.length - 1);

/** A height of the head: widest at depth zc, half-width a, front and back half-curves (see the bake script). */
type Slice = readonly number[];
function sliceAt(Y: number): Slice {
  const t = Math.min(Math.max((Y - Y0) / DY, 0), SLICES.length - 1);
  const i = Math.min(Math.floor(t), SLICES.length - 2);
  const f = t - i;
  return SLICES[i].map((v, j) => v + (SLICES[i + 1][j] - v) * f);
}

/** The skin at parameter t (0 the front middle, π/2 the patient's left, π the back): across and ahead, in picture widths. */
function pointOn(s: Slice, t: number): [number, number] {
  const [zc, a, bf, bb, nf, nb] = s;
  const front = Math.abs(t) <= Math.PI / 2;
  const n = front ? nf : nb;
  const sn = Math.sin(t);
  const cs = Math.abs(Math.cos(t)) ** (2 / n);
  return [a * Math.sign(sn) * Math.abs(sn) ** (2 / n), front ? zc + bf * cs : zc - bb * cs];
}

/** How squarely the skin there faces a picture: 1 straight at it, 0 edge on, below 0 turned away. */
function facing(s: Slice, t: number, v: View): number {
  const [, a, bf, bb, nf, nb] = s;
  const front = Math.abs(t) <= Math.PI / 2;
  const n = front ? nf : nb;
  const e = (2 * (n - 1)) / n;
  const nx = (Math.sign(Math.sin(t)) * Math.abs(Math.sin(t)) ** e) / a;
  const nz = ((front ? 1 : -1) * Math.abs(Math.cos(t)) ** e) / (front ? bf : bb);
  return (nx * Math.sin(v.psi) + nz * Math.cos(v.psi)) / (Math.hypot(nx, nz) || 1);
}

/** A height on the front picture, on this one; and back. */
function down(v: View, Y: number): number {
  const m = v.v;
  let i = 0;
  while (i < m.length - 2 && Y > m[i + 1][0]) i++;
  return m[i][1] + ((m[i + 1][1] - m[i][1]) * (Y - m[i][0])) / (m[i + 1][0] - m[i][0]);
}
function up(v: View, y: number): number {
  const m = v.v;
  let i = 0;
  while (i < m.length - 2 && y > m[i + 1][1]) i++;
  const Y = m[i][0] + ((m[i + 1][0] - m[i][0]) * (y - m[i][1])) / (m[i + 1][1] - m[i][1]);
  return Math.min(Math.max(Y, Y0), YMAX);
}

/** Across a picture, before bending. */
function across(v: View, s: Slice, t: number): number {
  const [X, Z] = pointOn(s, t);
  return v.c + v.k * (X * Math.cos(v.psi) - Z * Math.sin(v.psi));
}

/** How far a picture moves a spot of the head to meet its own eyes, nose, mouth and chin. */
function bend(v: View, t: number, Y: number): Pt {
  if (!v.fit) return { x: 0, y: 0 };
  const [X, Z] = pointOn(sliceAt(Y), t);
  const Yw = Y / ASPECT;
  let dx = 0;
  let dy = 0;
  for (let j = 0; j < v.fit.c.length; j++) {
    const [cx, cy, cz] = v.fit.c[j];
    const w = Math.exp(-((X - cx) ** 2 + (Yw - cy) ** 2 + (Z - cz) ** 2) / v.fit.s2);
    dx += v.fit.dx[j] * w;
    dy += v.fit.dy[j] * w;
  }
  return { x: dx, y: dy };
}

/**
 * The spot of the head under a place across a picture, at a height: of the skin
 * facing it, the one there. Off the head's edge, the edge.
 */
function under(v: View, x: number, Y: number): number {
  const s = sliceAt(Y);
  const N = 144;
  let pt = NaN;
  for (let i = 0; i < N; i++) {
    const t = -Math.PI + (2 * Math.PI * (i + 0.5)) / N;
    if (facing(s, t, v) <= 0) continue;
    const tx = across(v, s, t);
    if (x <= tx) {
      if (Number.isNaN(pt)) return t;
      let lo = pt;
      let hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (across(v, s, mid) < x) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    pt = t;
  }
  return pt;
}

/* ── The ears ─────────────────────────────────────────────────────────────── */

/** Where a place is in the ear's fan of triangles (bowl, rim i, rim i+1), if it is on the ear. */
function onEar(ear: Ear, p: Pt): { i: number; b: [number, number, number] } | null {
  const n = ear.rim.length;
  for (let i = 0; i < n; i++) {
    const a = ear.bowl;
    const b = ear.rim[i];
    const c = ear.rim[(i + 1) % n];
    const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / d;
    const l2 = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return { i, b: [l1, l2, l3] };
  }
  return null;
}

/* ── A dot ────────────────────────────────────────────────────────────────── */

type Spot = { ear: "l" | "r"; i: number; b: [number, number, number] } | { t: number; Y: number };

/** The spot of the head a dot is on, from the picture it was put on. */
function spotOf(p: { x: number; y: number; v?: FaceView }): Spot {
  const v = VIEWS[p.v ?? "front"];
  for (const ear of v.ears) {
    const e = onEar(ear, p);
    if (e) return { ear: ear.side, ...e };
  }
  // Undo this picture's bending: a few rounds settle it.
  let Y = up(v, p.y);
  let t = under(v, p.x, Y);
  for (let k = 0; k < (v.fit ? 4 : 0); k++) {
    const d = bend(v, t, Y);
    Y = up(v, p.y - d.y);
    t = under(v, p.x - d.x, Y);
  }
  return { t, Y };
}

const SEEN: Map<string, Spot> = new Map();

/**
 * Where a dot marked on one picture is on another, or null when that picture
 * does not see it: the other side of the head, or an ear turned away.
 */
export function placeOn(p: { x: number; y: number; v?: FaceView }, view: FaceView): Pt | null {
  const from = p.v ?? "front";
  if (from === view) return { x: p.x, y: p.y };
  const key = `${from}:${p.x}:${p.y}`;
  let s = SEEN.get(key);
  if (!s) {
    s = spotOf(p);
    if (SEEN.size > 4000) SEEN.clear();
    SEEN.set(key, s);
  }
  const v = VIEWS[view];
  if ("ear" in s) {
    const spot = s;
    const ear = v.ears.find((e) => e.side === spot.ear);
    if (!ear) return null;
    const n = ear.rim.length;
    const [a, b, c] = [ear.bowl, ear.rim[spot.i], ear.rim[(spot.i + 1) % n]];
    return { x: a.x * spot.b[0] + b.x * spot.b[1] + c.x * spot.b[2], y: a.y * spot.b[0] + b.y * spot.b[1] + c.y * spot.b[2] };
  }
  // The skin faces this picture, or is at its edge (the middle of the face, on both profiles).
  const sl = sliceAt(s.Y);
  if (facing(sl, s.t, v) < -0.03) return null;
  const d = bend(v, s.t, s.Y);
  const at = { x: across(v, sl, s.t) + d.x, y: down(v, s.Y) + d.y };
  // Behind an ear, where the ear stands in front of it.
  const side = s.t > 0 ? "l" : "r";
  if (Math.abs(s.t) > Math.PI / 2 && v.ears.some((e) => e.side === side && onEar(e, at))) return null;
  return at;
}
