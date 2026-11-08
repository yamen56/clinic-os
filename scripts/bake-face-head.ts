/**
 * The face chart's head: one shape behind its five pictures.
 *
 * Yamen, 2026-11-08: "when I put the dot on one place it should be accurate and
 * in the spot exactly, and not show in the other spot — if I put something on
 * the left ear it should not disturb my work on the right ear." A dot used to be
 * carried to the other views by its place inside a hand-drawn area, which knows
 * nothing of which side of the head it is on.
 *
 * So the five pictures (one mannequin, generated: front, turned each way, and
 * both profiles) are read as views of one head. Each height of it is a closed
 * curve — a front half and a back half, each as round or as pointed as the
 * pictures say — fitted to where the head's outline is on the front, side and
 * three-quarter pictures and to where the eyes and mouth are on the front and the
 * side. A dot is a spot on that head; a view draws it only when that skin faces
 * it, so the left ear's work never shows on the right profile.
 *
 * The pictures are not drawn to one scale (the turned views are about 9% taller
 * than the front, and their ears sit lower), so each view keeps its own heights,
 * and its own eyes, nose, mouth and chin pull the head a little to meet them. The
 * ears stand out from the head and are matched by their own outline.
 *
 *   npx tsx scripts/bake-face-head.ts
 *     → src/lib/charts/face/head-data.ts
 *     → scripts/qa-shots/face-head/*.png (the fit, and test dots, on each picture)
 */
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PICS = join(process.cwd(), "public", "charts", "face");
const GEN = join(process.cwd(), "src", "lib", "charts", "face", "head-data.ts");
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "face-head");
mkdirSync(SHOTS, { recursive: true });

const W = 945;
const H = 1264;
const DEG = Math.PI / 180;

type Pt = [number, number];
type Src = "front" | "left" | "front_left";

/* ── What the pictures show, measured on them (shares of the picture) ─────── */

/*
  Points every picture can be read for. L is the patient's left (the viewer's
  right on the front picture); R points are the same as L mirrored, and are
  given only where the front-left picture shows the far side of the face.
*/
/** `soft`: placed by reading the shading, so it bends the head but does not decide how the pictures are turned. */
type Mark = { id: string; side: "M" | "L"; front: Pt; left?: Pt; front_left?: Pt; far?: Pt; soft?: boolean };
const MARKS: Mark[] = [
  { id: "nasion", side: "M", front: [0.5, 0.372], left: [0.112, 0.4], front_left: [0.262, 0.395] },
  { id: "pronasale", side: "M", front: [0.5, 0.468], left: [0.033, 0.505], front_left: [0.192, 0.49] },
  { id: "subnasale", side: "M", front: [0.5, 0.5], left: [0.093, 0.548], front_left: [0.208, 0.535] },
  { id: "labrale_sup", side: "M", front: [0.5, 0.553], left: [0.083, 0.598], front_left: [0.222, 0.586] },
  { id: "stomion", side: "M", front: [0.5, 0.577], left: [0.1, 0.618], front_left: [0.235, 0.61] },
  { id: "labrale_inf", side: "M", front: [0.5, 0.615], left: [0.091, 0.642], front_left: [0.228, 0.652] },
  { id: "pogonion", side: "M", front: [0.5, 0.68], left: [0.11, 0.722], front_left: [0.215, 0.735] },
  { id: "menton", side: "M", front: [0.5, 0.716], left: [0.15, 0.773], front_left: [0.27, 0.777] },
  { id: "endocanthion", side: "L", front: [0.574, 0.379], left: [0.175, 0.422], front_left: [0.358, 0.396], far: [0.225, 0.399] },
  { id: "exocanthion", side: "L", front: [0.7, 0.38], left: [0.243, 0.41], front_left: [0.5, 0.397], far: [0.135, 0.412] },
  { id: "alare", side: "L", front: [0.567, 0.488], left: [0.143, 0.522], front_left: [0.315, 0.515], far: [0.178, 0.525] },
  { id: "cheilion", side: "L", front: [0.6, 0.583], left: [0.166, 0.627], front_left: [0.365, 0.622], far: [0.175, 0.62] },
  // Read off the shading rather than a crease: the cheekbone's top, under the eye's outer corner on every picture,
  // and the skin just in front of the ear.
  { id: "malar", side: "L", front: [0.69, 0.45], left: [0.248, 0.49], front_left: [0.49, 0.475], soft: true },
  { id: "preauricular", side: "L", front: [0.77, 0.46], left: [0.533, 0.515], front_left: [0.733, 0.525], soft: true },
];
/** The ones that say how pointed the face is at their height (the inner eye corner is sunk in, the nose wing stands out). */
const SHAPERS = ["exocanthion", "malar", "cheilion"];

/** The ear (the patient's left), on the pictures that show it: the bowl in its middle, then its outline. */
const EAR_KEYS = ["bowl", "top", "top_back", "back", "back_low", "lobe", "lobe_front", "tragus", "front_top"] as const;
type EarKey = (typeof EAR_KEYS)[number];
const EAR: Record<Src, Record<EarKey, Pt>> = {
  // Seen almost edge on: each point at the same share of the ear's height as on the profile.
  front: {
    bowl: [0.8, 0.438],
    top: [0.823, 0.351],
    top_back: [0.84, 0.368],
    back: [0.832, 0.421],
    back_low: [0.808, 0.49],
    lobe: [0.775, 0.521],
    lobe_front: [0.761, 0.512],
    tragus: [0.778, 0.443],
    front_top: [0.79, 0.372],
  },
  left: {
    bowl: [0.605, 0.5],
    top: [0.62, 0.4],
    top_back: [0.69, 0.42],
    back: [0.71, 0.48],
    back_low: [0.668, 0.56],
    lobe: [0.565, 0.596],
    lobe_front: [0.545, 0.575],
    tragus: [0.548, 0.505],
    front_top: [0.553, 0.425],
  },
  front_left: {
    bowl: [0.8, 0.49],
    top: [0.83, 0.4],
    top_back: [0.872, 0.418],
    back: [0.888, 0.47],
    back_low: [0.847, 0.55],
    lobe: [0.765, 0.589],
    lobe_front: [0.737, 0.572],
    tragus: [0.748, 0.515],
    front_top: [0.792, 0.423],
  },
};

/** Rows where the outline is the ear's or the nose's, not the head's: bridged over. */
const BRIDGE: Record<Src, { side: "l" | "r"; from: number; to: number }[]> = {
  front: [
    { side: "l", from: 0.34, to: 0.532 },
    { side: "r", from: 0.34, to: 0.532 },
  ],
  left: [{ side: "l", from: 0.4, to: 0.55 }],
  front_left: [{ side: "r", from: 0.39, to: 0.6 }],
};

/** Where the neck ends, at its front, on each picture. */
const NECK_FOOT: Record<Src, number> = { front: 0.968, left: 0.937, front_left: 0.956 };

/* ── The outlines ─────────────────────────────────────────────────────────── */

type Outline = { l: Float64Array; r: Float64Array; top: number; bottom: number };

async function outline(src: Src): Promise<Outline> {
  const file = join(PICS, `face-${src.replace("_", "-")}.webp`);
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== W || info.height !== H) throw new Error(`${file}: expected ${W}×${H}`);
  const l = new Float64Array(H).fill(NaN);
  const r = new Float64Array(H).fill(NaN);
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < H; y++) {
    let a = -1;
    let b = -1;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      // Off the white ground.
      if (3 * 254 - data[i] - data[i + 1] - data[i + 2] > 40) {
        if (a < 0) a = x;
        b = x;
      }
    }
    // A row with a few stray pixels is not the head.
    if (a >= 0 && b - a > 20) {
      l[y] = (a + 0.5) / W;
      r[y] = (b + 0.5) / W;
      if (top < 0) top = y;
      bottom = y;
    }
  }
  for (const br of BRIDGE[src]) {
    const e = br.side === "l" ? l : r;
    const y0 = Math.round(br.from * H);
    const y1 = Math.round(br.to * H);
    for (let y = y0 + 1; y < y1; y++) e[y] = e[y0] + ((e[y1] - e[y0]) * (y - y0)) / (y1 - y0);
  }
  return { l, r, top: top / H, bottom: bottom / H };
}

/** An outline's edge at a height, between rows; held at the last row past either end. */
function edgeAt(o: Outline, e: "l" | "r", y: number): number {
  const arr = o[e];
  const t = Math.min(Math.max(y * H, o.top * H), o.bottom * H);
  const i = Math.floor(t);
  const f = t - i;
  const a = arr[i];
  const b = arr[Math.min(i + 1, H - 1)];
  return Number.isNaN(b) ? a : a + (b - a) * f;
}

/** A piecewise-straight map of heights: front picture → this picture. */
type VMap = Pt[];
const vmapAt = (m: VMap, y: number): number => {
  let i = 0;
  while (i < m.length - 2 && y > m[i + 1][0]) i++;
  const [a, b] = [m[i], m[i + 1]];
  return a[1] + ((b[1] - a[1]) * (y - a[0])) / (b[0] - a[0]);
};

/* ── One height of the head ───────────────────────────────────────────────── */

/*
  A height of the head is two half-curves meeting where it is widest (depth zc,
  half-width a): in front, |x/a|^nf + |(z−zc)/bf|^nf = 1, and behind, the same
  with bb and nb. n = 2 is an oval; under 2 it comes to a point, as a face does
  at the mouth; over 2 it squares off.
*/
type Slice = [zc: number, a: number, bf: number, bb: number, nf: number, nb: number];

/** How far a half-curve reaches in a direction (sin ψ, cos ψ), measured from its centre. */
function reach(a: number, b: number, n: number, psi: number): number {
  const m = n / (n - 1);
  return (Math.abs(a * Math.sin(psi)) ** m + Math.abs(b * Math.cos(psi)) ** m) ** (1 / m);
}

/** The point at parameter t (0 the front middle, π/2 the patient's left, π the back): across, ahead. */
function pointOn(s: Slice, t: number): [number, number] {
  const [zc, a, bf, bb, nf, nb] = s;
  const front = Math.abs(t) <= Math.PI / 2;
  const n = front ? nf : nb;
  const sn = Math.sin(t);
  const cs = Math.cos(t);
  const X = a * Math.sign(sn) * Math.abs(sn) ** (2 / n);
  const Z = front ? zc + bf * Math.abs(cs) ** (2 / n) : zc - bb * Math.abs(cs) ** (2 / n);
  return [X, Z];
}

/** The way the skin faces there, as a unit vector (across, ahead). */
function normalOn(s: Slice, t: number): [number, number] {
  const [, a, bf, bb, nf, nb] = s;
  const front = Math.abs(t) <= Math.PI / 2;
  const n = front ? nf : nb;
  const b = front ? bf : bb;
  const sn = Math.abs(Math.sin(t));
  const cs = Math.abs(Math.cos(t));
  const nx = (Math.sign(Math.sin(t)) * sn ** ((2 * (n - 1)) / n)) / a;
  const nz = ((front ? 1 : -1) * cs ** ((2 * (n - 1)) / n)) / b;
  const l = Math.hypot(nx, nz) || 1;
  return [nx / l, nz / l];
}

async function main() {
  const out = { front: await outline("front"), left: await outline("left"), front_left: await outline("front_left") };

  // The side picture's centre line: any, the three-quarter fit takes it up.
  const cS = 0.55;

  /* Each turned picture is the head at its own scale: top of the head to the chin, against the front's. */
  const chin = MARKS.find((m) => m.id === "menton")!;
  const scale = (src: "left" | "front_left") => (chin[src]![1] - out[src].top) / (chin.front[1] - out.front.top);
  const kQ = scale("front_left");

  /* The three-quarter view, from the points it shares with the front and the
     side: across it is a + b·(across on the front) + c·(across on the side), and
     with its scale known, b and c say how far it is turned and how deep the side
     picture's head is against the front's. */
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (const m of MARKS) {
    if (!m.left || m.soft) continue;
    const X = m.front[0] - 0.5;
    if (m.front_left) {
      rows.push([1, X, m.left[0]]);
      rhs.push(m.front_left[0]);
    }
    if (m.far) {
      rows.push([1, -X, m.left[0]]);
      rhs.push(m.far[0]);
    }
  }
  const AtA = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const Atb = [0, 1, 2].map((i) => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0));
  const [ca, cb, cc] = solve(AtA, Atb);
  const psiQ = Math.acos(Math.min(1, cb / kQ));
  // x_Q = cQ + kQ·(X cos ψ − Z sin ψ), Z = (cS − x_S)/kS: the side's term is kQ sin ψ / kS.
  const kS = (kQ * Math.sin(psiQ)) / cc;
  const cQ = ca + cc * cS;
  const rms = Math.sqrt(rows.reduce((s, r, k) => s + (ca + cb * r[1] + cc * r[2] - rhs[k]) ** 2, 0) / rows.length);
  console.log(`scales: side ${kS.toFixed(4)} across (${scale("left").toFixed(4)} down), ¾ ${kQ.toFixed(4)}; three-quarter view turned ${(psiQ / DEG).toFixed(2)}°, rms ${rms.toFixed(4)}`);

  // Heights: the top of the head, the eyes, under the nose, the mouth, the chin, the neck's foot.
  const anchor = (id: string) => MARKS.find((m) => m.id === id)!;
  const vmap = (src: Src): VMap => {
    if (src === "front") return [[0, 0], [1, 1]];
    const pts: Pt[] = [[out.front.top, out[src].top]];
    for (const id of ["exocanthion", "subnasale", "stomion", "menton"]) {
      const m = anchor(id);
      pts.push([m.front[1], m[src]![1]]);
    }
    pts.push([NECK_FOOT.front, NECK_FOOT[src]]);
    return pts;
  };
  const V: Record<Src, VMap> = { front: vmap("front"), left: vmap("left"), front_left: vmap("front_left") };

  /* Each height: its widest (front picture), its front and back (profile), and how
     far it reaches toward the front-right and the back-left (three-quarter). */
  const Y0 = Math.ceil(out.front.top * 1000) / 1000;
  const Y1 = NECK_FOOT.front;
  const DY = 0.004;
  const psiF = Math.PI / 2 - psiQ; // the three-quarter picture's left edge faces this way (mirrored to the patient's left)
  const psiB = Math.PI / 2 + psiQ; // and its right edge this way
  type Raw = { Y: number; a: number; zf: number; zb: number; sf: number; sb: number };
  const raws: Raw[] = [];
  for (let Y = Y0; Y <= Y1 + 1e-9; Y += DY) {
    const ys = vmapAt(V.left, Y);
    const yq = vmapAt(V.front_left, Y);
    raws.push({
      Y,
      a: Math.max((edgeAt(out.front, "r", Y) - edgeAt(out.front, "l", Y)) / 2, 0.004),
      zf: (cS - edgeAt(out.left, "l", ys)) / kS,
      zb: (cS - edgeAt(out.left, "r", ys)) / kS,
      sf: -(edgeAt(out.front_left, "l", yq) - cQ) / kQ,
      sb: (edgeAt(out.front_left, "r", yq) - cQ) / kQ,
    });
  }
  const at = (Y: number) => raws[Math.min(Math.max(Math.round((Y - Y0) / DY), 0), raws.length - 1)];
  const scan = (lo: number, hi: number, f: (v: number) => number) => {
    let best = lo;
    let bestE = Infinity;
    for (let i = 0; i <= 400; i++) {
      const v = lo + ((hi - lo) * i) / 400;
      const e = Math.abs(f(v));
      if (e < bestE) {
        bestE = e;
        best = v;
      }
    }
    return best;
  };
  const nfFor = (r: Raw, zc: number) => scan(1.15, 6, (n) => zc * Math.cos(psiF) + reach(r.a, r.zf - zc, n, psiF) - r.sf);
  const nbFor = (r: Raw, zc: number) => scan(1.15, 6, (n) => zc * Math.cos(psiB) + reach(r.a, zc - r.zb, n, psiB) - r.sb);

  /* Where each height is widest, front to back: at the ear (the skin just in
     front of it), down to the angle of the jaw, then the middle of the neck. */
  const faceBottom = anchor("menton").front[1];
  const zEar = (cS - anchor("preauricular").left![0]) / kS;
  const zJaw = (cS - 0.49) / kS;
  const zcAt = (r: Raw) => {
    const mid = (r.zf + r.zb) / 2;
    if (r.Y <= 0.52) return zEar;
    if (r.Y <= 0.62) return zEar + ((zJaw - zEar) * (r.Y - 0.52)) / 0.1;
    if (r.Y <= faceBottom) return zJaw + ((at(faceBottom).zf + at(faceBottom).zb) / 2 - zJaw) * ((r.Y - 0.62) / (faceBottom - 0.62));
    return mid;
  };

  /* How pointed the face is at the eyes' outer corners, the cheekbones and the
     mouth's corners: the front curve passes through them as the profile has them. */
  const pointed: Pt[] = SHAPERS.map((id) => {
    const m = anchor(id);
    const r = at(m.front[1]);
    const X = m.front[0] - 0.5;
    const Z = (cS - m.left![0]) / kS;
    const zc = zcAt(r);
    const n = scan(1.15, 4, (n) => Math.abs(X / r.a) ** n + Math.abs((Z - zc) / (r.zf - zc)) ** n - 1);
    console.log(`${id}: the face's front at its height is n = ${n.toFixed(2)}`);
    return [m.front[1], n];
  });
  const faceTop = pointed[0][0] - 0.03;

  /* Every height: in the face, as pointed as those say; above it and below the
     chin, as round as the three-quarter outline says. The back follows the outline. */
  const fitted: number[][] = raws.map((r) => {
    const zc = Math.min(Math.max(zcAt(r), r.zb + 0.1 * (r.zf - r.zb)), r.zf - 0.1 * (r.zf - r.zb));
    const nf = r.Y < faceTop || r.Y > faceBottom ? nfFor(r, zc) : vmapAt(pointed, Math.min(Math.max(r.Y, pointed[0][0]), pointed[pointed.length - 1][0]));
    return [zc, r.a, r.zf - zc, zc - r.zb, nf, nbFor(r, zc)];
  });
  // Each height a little like its neighbours: the outlines are read to the pixel, the head is smooth.
  const slices: Slice[] = fitted.map((_, i) => {
    const acc = [0, 0, 0, 0, 0, 0];
    let ws = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(fitted.length - 1, i + 5); j++) {
      const w = Math.exp(-((j - i) ** 2) / (2 * 2 * 2));
      ws += w;
      for (let k = 0; k < 6; k++) acc[k] += fitted[j][k] * w;
    }
    // The front and back stay where the profile has them; only the shape between is smoothed.
    const s = acc.map((v) => v / ws);
    const zf = fitted[i][0] + fitted[i][2];
    const zb = fitted[i][0] - fitted[i][3];
    return [s[0], fitted[i][1], zf - s[0], s[0] - zb, s[4], s[5]].map(round) as Slice;
  });

  /* The model, as the chart will run it (the same sums as head.ts). */
  const views = {
    front: { psi: 0, c: 0.5, k: 1, v: V.front },
    left: { psi: Math.PI / 2, c: cS, k: kS, v: V.left },
    front_left: { psi: psiQ, c: cQ, k: kQ, v: V.front_left },
  };
  const sliceAt = (Y: number): Slice => {
    const t = Math.min(Math.max((Y - Y0) / DY, 0), slices.length - 1);
    const i = Math.min(Math.floor(t), slices.length - 2);
    const f = t - i;
    return slices[i].map((v, j) => v + (slices[i + 1][j] - v) * f) as Slice;
  };
  const project = (src: Src, t: number, Y: number): Pt => {
    const vw = views[src];
    const [X, Z] = pointOn(sliceAt(Y), t);
    return [vw.c + vw.k * (X * Math.cos(vw.psi) - Z * Math.sin(vw.psi)), vmapAt(vw.v, Y)];
  };
  const facing = (src: Src, t: number, Y: number) => {
    const [nx, nz] = normalOn(sliceAt(Y), t);
    return nx * Math.sin(views[src].psi) + nz * Math.cos(views[src].psi);
  };
  const unprojectFront = (x: number, Y: number): number => {
    let lo = -Math.PI / 2;
    let hi = Math.PI / 2;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (project("front", mid, Y)[0] < x) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  /* Where the model puts each point on each picture, against where the picture has it. */
  type Res = { id: string; t: number; Y: number; res: Partial<Record<Src | "far", Pt>> };
  const residuals: Res[] = MARKS.map((m) => {
    const Y = m.front[1];
    const t = unprojectFront(m.front[0], Y);
    const r: Res = { id: m.id, t, Y, res: {} };
    for (const src of ["left", "front_left"] as Src[]) {
      const p = m[src];
      if (!p) continue;
      const q = project(src, t, Y);
      r.res[src] = [round(p[0] - q[0]), round(p[1] - q[1])];
    }
    if (m.far) {
      const q = project("front_left", -t, Y);
      r.res.far = [round(m.far[0] - q[0]), round(m.far[1] - q[1])];
    }
    return r;
  });
  for (const r of residuals) console.log(r.id.padEnd(14), `t ${(r.t / DEG).toFixed(1).padStart(6)}°`, JSON.stringify(r.res));

  /* Drawn on each picture: lines of the head, the measured points (green) and where the model alone puts them (red). */
  for (const src of ["front", "left", "front_left"] as Src[]) {
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
    for (let d = -180; d < 180; d += 15) {
      const t = d * DEG;
      let path = "";
      for (let Y = Y0; Y <= Y1; Y += 0.004) {
        if (facing(src, t, Y) < -0.02) {
          if (path && !path.endsWith(" ")) path += " ";
          continue;
        }
        const [x, y] = project(src, t, Y);
        path += `${!path || path.endsWith(" ") ? "M" : "L"}${(x * W).toFixed(1)},${(y * H).toFixed(1)}`;
      }
      svg += `<path d="${path}" fill="none" stroke="${d === 0 ? "#d00" : d === 90 || d === -90 ? "#00d" : "#0a0"}" stroke-width="1" stroke-opacity="0.7"/>`;
    }
    for (let Y = Y0 + 0.02; Y <= Y1; Y += 0.04) {
      let path = "";
      for (let d = -180; d <= 180; d += 2) {
        const t = d * DEG;
        if (facing(src, t, Y) < -0.02) {
          if (path && !path.endsWith(" ")) path += " ";
          continue;
        }
        const [x, y] = project(src, t, Y);
        path += `${!path || path.endsWith(" ") ? "M" : "L"}${(x * W).toFixed(1)},${(y * H).toFixed(1)}`;
      }
      svg += `<path d="${path}" fill="none" stroke="#a0a" stroke-width="0.8" stroke-opacity="0.6"/>`;
    }
    for (const r of residuals) {
      const m = MARKS.find((x) => x.id === r.id)!;
      const pairs: [Pt | undefined, number][] = src === "front" ? [[m.front, r.t]] : [[m[src], r.t], ...(src === "front_left" && m.far ? [[m.far, -r.t] as [Pt, number]] : [])];
      for (const [p, t] of pairs) {
        if (!p) continue;
        const q = project(src, t, r.Y);
        svg += `<line x1="${q[0] * W}" y1="${q[1] * H}" x2="${p[0] * W}" y2="${p[1] * H}" stroke="#000" stroke-width="1"/>`;
        svg += `<circle cx="${q[0] * W}" cy="${q[1] * H}" r="4" fill="#e00"/>`;
        svg += `<circle cx="${p[0] * W}" cy="${p[1] * H}" r="4" fill="#0b0" stroke="#fff"/>`;
      }
    }
    for (const k of EAR_KEYS) {
      const [x, y] = EAR[src][k];
      svg += `<circle cx="${x * W}" cy="${y * H}" r="4" fill="#f80" stroke="#fff"/>`;
    }
    svg += `</svg>`;
    await sharp(join(PICS, `face-${src.replace("_", "-")}.webp`))
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toFile(join(SHOTS, `fit-${src}.png`));
  }

  /* How each turned picture bends the head to meet its own eyes, nose, mouth and
     chin: a smooth push that is exactly each point's at that point and fades
     within a few centimetres of it (Gaussian bumps, solved to fit). */
  const SIGMA = 0.03;
  const fitFor = (src: "left" | "front_left") => {
    const c: [number, number, number][] = [];
    const dx: number[] = [];
    const dy: number[] = [];
    for (const r of residuals) {
      const add = (t: number, d: Pt | undefined) => {
        if (!d) return;
        const [X, Z] = pointOn(sliceAt(r.Y), t);
        c.push([round(X), round(r.Y / (W / H)), round(Z)]);
        dx.push(d[0]);
        dy.push(d[1]);
      };
      add(r.t, r.res[src]);
      if (src === "front_left") add(-r.t, r.res.far);
    }
    const n = c.length;
    const K = c.map((p) => c.map((q) => Math.exp(-((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2) / (2 * SIGMA * SIGMA))));
    for (let i = 0; i < n; i++) K[i][i] += 1e-4;
    return { sigma: SIGMA, c, dx: solve(K.map((r) => [...r]), dx).map(round), dy: solve(K.map((r) => [...r]), dy).map(round) };
  };
  const fit = { left: fitFor("left"), front_left: fitFor("front_left") };

  /* The data the chart runs on. */
  const viewsOut = {
    front: { psi: 0, c: 0.5, k: 1, v: V.front },
    left: { psi: 90, c: round(cS), k: round(kS), v: V.left.map(([a, b]) => [round(a), round(b)]) },
    front_left: { psi: round(psiQ / DEG), c: round(cQ), k: round(kQ), v: V.front_left.map(([a, b]) => [round(a), round(b)]) },
  };
  const src = `/*
  Generated by scripts/bake-face-head.ts from the five face pictures: do not edit
  by hand; change the measurements there and run it again.
*/

/** How each picture sees the head: turned \`psi\`° to the patient's left, across at \`c\` + \`k\`·(the head across), and its heights against the front's. The right-hand views are these mirrored. */
export const HEAD_VIEWS = ${JSON.stringify(viewsOut)} as const;

/** The head, height by height from \`y0\` every \`dy\`: [widest at depth, half-width, front depth, back depth, front shape, back shape] (scripts/bake-face-head.ts \`Slice\`). */
export const HEAD_SLICES: { y0: number; dy: number; s: [number, number, number, number, number, number][] } = { y0: ${Y0}, dy: ${DY}, s: ${JSON.stringify(slices)} };

/** How a turned picture bends the head to meet its own face: bumps of width \`sigma\` at \`c\` (across, down, ahead, in picture widths), each moving the picture by \`dx\`, \`dy\`. From: ${MARKS.map((m) => m.id).join(", ")}. */
export const HEAD_FIT: Record<"left" | "front_left", { sigma: number; c: [number, number, number][]; dx: number[]; dy: number[] }> = ${JSON.stringify(fit)};

/** The patient's left ear on the pictures that show it, in this order: ${EAR_KEYS.join(", ")}. */
export const HEAD_EAR: Record<"front" | "left" | "front_left", [number, number][]> = ${JSON.stringify(Object.fromEntries((["front", "left", "front_left"] as Src[]).map((s) => [s, EAR_KEYS.map((k) => EAR[s][k])])))};
`;
  writeFileSync(GEN, src);
  console.log("wrote", GEN);
  await probes();
}

function round(v: number) {
  return Math.round(v * 1e5) / 1e5;
}

/** Gaussian elimination: a small square system. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/*
  Points that were not used to fit the head, put on one picture and drawn where
  the chart then draws them on every picture, to look at. The picture a point
  was put on draws it with a black ring.
*/
const PROBES: { id: string; v: Src | "right" | "front_right"; at: Pt }[] = [
  { id: "forehead", v: "front", at: [0.5, 0.25] },
  { id: "foreheadL", v: "front", at: [0.63, 0.23] },
  { id: "browtailL", v: "front", at: [0.725, 0.345] },
  { id: "templeL", v: "front", at: [0.765, 0.3] },
  { id: "cheekboneL", v: "front", at: [0.69, 0.45] },
  { id: "cheekL", v: "front", at: [0.655, 0.53] },
  { id: "nasolabL", v: "front", at: [0.585, 0.54] },
  { id: "marionL", v: "front", at: [0.6, 0.64] },
  { id: "chinL", v: "front", at: [0.56, 0.69] },
  { id: "jawL", v: "front", at: [0.665, 0.665] },
  { id: "neck", v: "front", at: [0.5, 0.8] },
  { id: "neckL", v: "front", at: [0.62, 0.8] },
  { id: "cheekR", v: "front", at: [0.345, 0.53] },
  { id: "earL-f", v: "front", at: [0.81, 0.44] },
  { id: "earR-f", v: "front", at: [0.19, 0.44] },
  { id: "scalp", v: "left", at: [0.5, 0.12] },
  { id: "templeS", v: "left", at: [0.36, 0.34] },
  { id: "cheekS", v: "left", at: [0.33, 0.55] },
  { id: "jawangle", v: "left", at: [0.49, 0.68] },
  { id: "behindear", v: "left", at: [0.76, 0.5] },
  { id: "occiput", v: "left", at: [0.88, 0.4] },
  { id: "nape", v: "left", at: [0.8, 0.72] },
  { id: "neckside", v: "left", at: [0.58, 0.82] },
  { id: "earL-s", v: "left", at: [0.64, 0.47] },
  { id: "lobeL", v: "left", at: [0.56, 0.585] },
  { id: "cheekQ", v: "front_left", at: [0.52, 0.55] },
  { id: "farcheek", v: "front_left", at: [0.16, 0.5] },
  { id: "earR-q", v: "front_right", at: [0.2, 0.5] },
];
const COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#008080", "#9a6324", "#800000", "#808000", "#000075", "#e6beff"];

async function probes() {
  const { placeOn } = await import("../src/lib/charts/face/head");
  const all = ["left", "front_left", "front", "front_right", "right"] as const;
  for (const target of all) {
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
    PROBES.forEach((p, i) => {
      const at = placeOn({ x: p.at[0], y: p.at[1], v: p.v }, target);
      if (!at) return;
      const col = COLORS[i % COLORS.length];
      const own = p.v === target;
      svg += `<circle cx="${at.x * W}" cy="${at.y * H}" r="6" fill="${col}" stroke="${own ? "#000" : "#fff"}" stroke-width="${own ? 3 : 2}"/>`;
      svg += `<text x="${at.x * W + 8}" y="${at.y * H - 6}" font-size="15" font-family="Arial" font-weight="bold" fill="${col}" stroke="#fff" stroke-width="0.6">${p.id}</text>`;
    });
    svg += `</svg>`;
    await sharp(join(PICS, `face-${target.replace("_", "-")}.webp`))
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toFile(join(SHOTS, `probe-${target}.png`));
  }
  console.log("probes drawn in", SHOTS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
