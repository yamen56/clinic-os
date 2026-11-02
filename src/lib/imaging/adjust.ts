/**
 * Reading an x-ray the way imaging software lets a dentist (Yamen,
 * 2026-11-02: "the sharpness … all other types of x-ray image adjustment and a
 * brush and all tools that the doctor may need"), in the browser, on the
 * picture's own pixels — so what is on the screen is exactly what Save writes
 * and what the patient is sent.
 *
 * Two halves, both pure:
 *  - the exposure: orientation, then a tone curve (brightness, contrast,
 *    gamma, invert, an auto contrast that spreads the greys), then sharpening,
 *    relief, and colour maps that make density differences easy to see;
 *  - the marks drawn on top: brush, arrow, line, circle, text, a ruler that
 *    reads millimetres once calibrated, and an angle. Their points are in the
 *    picture's own pixels (after rotating), so they stay on what they mark
 *    whatever the zoom, and are drawn the same on the screen and in the file.
 */

export type Colours = "off" | "heat" | "rainbow";

export type Adjust = {
  /** -100…100 */
  bright: number;
  /** -100…100 */
  contrast: number;
  /** 0.3…3, 1 is none */
  gamma: number;
  /** 0…100 */
  sharp: number;
  invert: boolean;
  /** Spread the greys over the whole range — "auto contrast". */
  equalize: boolean;
  /** Relief: edges raised, as if lit from the side. */
  emboss: boolean;
  colours: Colours;
  rot: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
};

export const NO_ADJUST: Adjust = {
  bright: 0,
  contrast: 0,
  gamma: 1,
  sharp: 0,
  invert: false,
  equalize: false,
  emboss: false,
  colours: "off",
  rot: 0,
  flipH: false,
  flipV: false,
};

export function isAdjusted(a: Adjust): boolean {
  return (Object.keys(NO_ADJUST) as (keyof Adjust)[]).some((k) => a[k] !== NO_ADJUST[k]);
}

/** Width and height once turned. */
export function orientedSize(w: number, h: number, rot: number): [number, number] {
  return rot % 180 ? [h, w] : [w, h];
}

/** The picture, turned and flipped, into a canvas `scale` times its own size. */
export function drawOriented(ctx: CanvasRenderingContext2D, img: CanvasImageSource, natW: number, natH: number, a: Adjust, scale: number) {
  const [W, H] = orientedSize(natW * scale, natH * scale, a.rot);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  // Flipped as seen, after turning.
  ctx.scale(a.flipH ? -1 : 1, a.flipV ? -1 : 1);
  ctx.rotate((a.rot * Math.PI) / 180);
  ctx.drawImage(img, (-natW * scale) / 2, (-natH * scale) / 2, natW * scale, natH * scale);
  ctx.restore();
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const lum = (d: Uint8ClampedArray, i: number) => (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;

/** The exposure, on pixels already turned. Returns new pixels; the input is left alone. */
export function processPixels(src: ImageData, a: Adjust): ImageData {
  const { width: w, height: h } = src;
  const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
  const d = out.data;

  // One tone curve for every channel: auto contrast, brightness and contrast, gamma, invert.
  let eq: Uint8Array | null = null;
  if (a.equalize) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[lum(d, i)]++;
    const total = w * h;
    let first = 0;
    while (first < 255 && hist[first] === 0) first++;
    const cdfMin = hist[first];
    eq = new Uint8Array(256);
    let cdf = 0;
    for (let v = 0; v < 256; v++) {
      cdf += hist[v];
      eq[v] = total === cdfMin ? v : Math.round(((cdf - cdfMin) / (total - cdfMin)) * 255);
    }
  }
  const C = a.contrast * 2.55;
  const f = (259 * (C + 255)) / (255 * (259 - C));
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = eq ? eq[v] : v;
    x = f * (x - 128) + 128 + a.bright * 2.55;
    x = 255 * Math.pow(clamp(x) / 255, 1 / a.gamma);
    lut[v] = a.invert ? 255 - x : x;
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }

  // Sharpening: the picture minus its blur, added back.
  if (a.sharp > 0) {
    const k = (a.sharp / 100) * 2;
    const s = new Uint8ClampedArray(d);
    const row = w * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * row + x * 4;
        for (let c = 0; c < 3; c++) {
          const j = i + c;
          d[j] = (1 + 4 * k) * s[j] - k * (s[j - 4] + s[j + 4] + s[j - row] + s[j + row]);
        }
      }
    }
  }

  // Relief: the difference across a diagonal, on grey.
  if (a.emboss) {
    const g = new Uint8ClampedArray(w * h);
    for (let p = 0, i = 0; p < g.length; p++, i += 4) g[p] = lum(d, i);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const prev = g[Math.max(0, y - 1) * w + Math.max(0, x - 1)];
        const next = g[Math.min(h - 1, y + 1) * w + Math.min(w - 1, x + 1)];
        const v = clamp(128 + (next - prev) * 2 + (g[p] - 128) * 0.35);
        const i = p * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  }

  // Colour maps: density as colour, dark to light.
  if (a.colours !== "off") {
    const map = colourMap(a.colours);
    for (let i = 0; i < d.length; i += 4) {
      const m = lum(d, i) * 3;
      d[i] = map[m];
      d[i + 1] = map[m + 1];
      d[i + 2] = map[m + 2];
    }
  }
  return out;
}

function colourMap(kind: Exclude<Colours, "off">): Uint8ClampedArray {
  const m = new Uint8ClampedArray(256 * 3);
  const c1 = (v: number) => Math.max(0, Math.min(1, v)) * 255;
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    const [r, g, b] =
      kind === "heat" ? [c1(3 * t), c1(3 * t - 1), c1(3 * t - 2)] : [c1(1.5 - Math.abs(4 * t - 3)), c1(1.5 - Math.abs(4 * t - 2)), c1(1.5 - Math.abs(4 * t - 1))];
    m[v * 3] = r;
    m[v * 3 + 1] = g;
    m[v * 3 + 2] = b;
  }
  return m;
}

/* ── Marks ──────────────────────────────────────────────────────────── */

export type Pt = [number, number];
type Base = { id: string; color: string; w: number };
export type Mark =
  | (Base & { t: "pen"; pts: Pt[] })
  | (Base & { t: "line" | "arrow" | "ruler"; a: Pt; b: Pt })
  | (Base & { t: "circle"; a: Pt; b: Pt })
  | (Base & { t: "angle"; a: Pt; b: Pt; c: Pt })
  | (Base & { t: "text"; a: Pt; text: string });

export const MARK_COLOURS = ["#ef4444", "#facc15", "#22c55e", "#38bdf8", "#ffffff"] as const;

/** A stroke as thick on a 600-pixel picture as on a 3,000-pixel one. */
export function strokeUnit(W: number, H: number): number {
  return Math.max(1, Math.hypot(W, H) / 800);
}

export const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** The angle at b, in degrees. */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const u = Math.atan2(a[1] - b[1], a[0] - b[0]);
  const v = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let deg = Math.abs(((v - u) * 180) / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return deg;
}

/** "12.4 mm" once calibrated; pixels until then. */
export function lengthLabel(a: Pt, b: Pt, mmPerPx: number | null): string {
  const px = dist(a, b);
  return mmPerPx ? `${(px * mmPerPx).toFixed(1)} mm` : `${Math.round(px)} px`;
}

/** The marks moved with the picture when it is turned or flipped as seen; W and H are its size before. */
export function moveMarks(marks: Mark[], op: "cw" | "ccw" | "flipH" | "flipV", W: number, H: number): Mark[] {
  const f = (p: Pt): Pt =>
    op === "cw" ? [H - p[1], p[0]] : op === "ccw" ? [p[1], W - p[0]] : op === "flipH" ? [W - p[0], p[1]] : [p[0], H - p[1]];
  return marks.map((m) => {
    if (m.t === "pen") return { ...m, pts: m.pts.map(f) };
    if (m.t === "angle") return { ...m, a: f(m.a), b: f(m.b), c: f(m.c) };
    if (m.t === "text") return { ...m, a: f(m.a) };
    return { ...m, a: f(m.a), b: f(m.b) };
  });
}

/** An arrowhead's two barbs at b, coming from a. */
export function arrowHead(a: Pt, b: Pt, size: number): [Pt, Pt] {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const s = 0.45;
  return [
    [b[0] - size * Math.cos(ang - s), b[1] - size * Math.sin(ang - s)],
    [b[0] - size * Math.cos(ang + s), b[1] - size * Math.sin(ang + s)],
  ];
}

/** The short ticks across a ruler's ends. */
export function rulerTicks(a: Pt, b: Pt, len: number): [Pt, Pt, Pt, Pt] {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
  const dx = (Math.cos(ang) * len) / 2;
  const dy = (Math.sin(ang) * len) / 2;
  return [
    [a[0] - dx, a[1] - dy],
    [a[0] + dx, a[1] + dy],
    [b[0] - dx, b[1] - dy],
    [b[0] + dx, b[1] + dy],
  ];
}

/** The arc drawn inside an angle, and where its number goes. */
export function angleArc(a: Pt, b: Pt, c: Pt): { r: number; from: number; to: number; sweep: 0 | 1; label: Pt; largeArc: 0 } {
  const r = Math.max(8, Math.min(dist(a, b), dist(c, b)) * 0.3);
  const from = Math.atan2(a[1] - b[1], a[0] - b[0]);
  let to = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  to = from + delta;
  const mid = from + delta / 2;
  return { r, from, to, sweep: delta > 0 ? 1 : 0, label: [b[0] + Math.cos(mid) * r * 1.9, b[1] + Math.sin(mid) * r * 1.9], largeArc: 0 };
}

/** A ruler's or angle's number: on the white side of the line, legible on any picture. */
export function labelAt(m: Mark, mmPerPx: number | null): { at: Pt; text: string } | null {
  if (m.t === "ruler") return { at: [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2 - m.w * 4], text: lengthLabel(m.a, m.b, mmPerPx) };
  if (m.t === "angle") return { at: angleArc(m.a, m.b, m.c).label, text: `${angleAt(m.a, m.b, m.c).toFixed(1)}°` };
  return null;
}

/** The marks, into a canvas whose units are the picture's own pixels (scaled with ctx.scale for anything else). */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[], mmPerPx: number | null) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const line = (p: Pt, q: Pt) => {
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  };
  const label = (at: Pt, text: string, size: number, color: string) => {
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = size / 5;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(text, at[0], at[1]);
    ctx.fillStyle = color;
    ctx.fillText(text, at[0], at[1]);
  };
  for (const m of marks) {
    ctx.strokeStyle = m.color;
    ctx.fillStyle = m.color;
    ctx.lineWidth = m.w;
    if (m.t === "pen") {
      ctx.beginPath();
      m.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
    } else if (m.t === "line" || m.t === "arrow" || m.t === "ruler") {
      line(m.a, m.b);
      if (m.t === "arrow") {
        const [l, r] = arrowHead(m.a, m.b, m.w * 4.5);
        line(m.b, l);
        line(m.b, r);
      }
      if (m.t === "ruler") {
        const [a1, a2, b1, b2] = rulerTicks(m.a, m.b, m.w * 5);
        line(a1, a2);
        line(b1, b2);
      }
    } else if (m.t === "circle") {
      ctx.beginPath();
      ctx.arc(m.a[0], m.a[1], dist(m.a, m.b), 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.t === "angle") {
      line(m.b, m.a);
      line(m.b, m.c);
      const arc = angleArc(m.a, m.b, m.c);
      ctx.beginPath();
      ctx.arc(m.b[0], m.b[1], arc.r, arc.from, arc.to, arc.sweep === 0);
      ctx.stroke();
    } else if (m.t === "text") {
      label(m.a, m.text, m.w * 7, m.color);
    }
    const l = labelAt(m, mmPerPx);
    if (l) label(l.at, l.text, m.w * 5.5, m.color);
  }
  ctx.restore();
}
