/**
 * The gum, rendered one column at a time so columns tile along the arch. The
 * scalloped gum round a tooth (render-tooth-art.tsx) and the smooth healed
 * ridge where a tooth is gone (render-prosthesis-art.tsx) are the same tissue
 * with a different edge.
 */
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { CW, SIDE_H, GEOM, GUM_PAD } from "../src/components/charts/dental/tooth-art";
import { bevel, clamp, distance, hex, mix, noise, normalAt, saveArt, shade, smooth, type RGB } from "./lib-art";

const { C, Y0, PAP } = GEOM;
export const S = 5; // pixels per drawing unit: the tooth's full view is ~3.4 px/unit on a 2x phone

/* ── The gum, one column wide, tiling ────────────────────────────────────── */
const GUM_MARGIN = hex("#f4b3ad");
const GUM = hex("#ea9496");
const MUCOSA = hex("#c4505f");
const SHADOW = hex("#6e2f35");

/**
 * One column of gum, saved as `name`: `tissue` is the gum in the column itself
 * and in its two neighbours, left first — they decide how its edges meet.
 */
export async function renderGum(dir: string, name: string, arch: "upper" | "lower", tissue: [string, string, string], castShadow = 0.26) {
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
  const cv = createCanvas(W3, h);
  const g = cv.getContext("2d");
  g.fillStyle = "#000";
  for (let k = 0; k < 3; k++) {
    g.setTransform(S, 0, 0, S, k * w, 0);
    g.fill(new Path2D(tissue[k]));
  }
  const data = g.getImageData(0, 0, W3, h).data;
  const cov3 = new Float32Array(W3 * h);
  for (let i = 0; i < cov3.length; i++) cov3[i] = data[i * 4 + 3] / 255;
  const d3 = distance(cov3, W3, h);
  // And from outside it: how far below the margin a point on the tooth is, for the shadow the gum casts.
  const out3 = new Float32Array(W3 * h);
  for (let i = 0; i < out3.length; i++) out3[i] = 1 - cov3[i];
  const dOut3 = distance(out3, W3, h);

  const R = 5.5 * S;
  const hf = new Float32Array(wo * h);
  const cov = new Float32Array(wo * h);
  const dist = new Float32Array(wo * h);
  const below = new Float32Array(wo * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < wo; x++) {
      const j = y * W3 + (x + w - P);
      const i = y * wo + x;
      cov[i] = cov3[j];
      dist[i] = d3[j];
      below[i] = dOut3[j];
      if (cov3[j] <= 0) continue;
      const ux = (x - P) / S;
      const uy = y / S;
      // The free margin rolls over the tooth; above it the attached gum is firm and stippled.
      let v = bevel(d3[j], R);
      // Each noise fits a whole number of cells across one column (75, 194), or every tile edge is a seam.
      v += 1.1 * (noise((ux * 75) / CW, uy * 1.7, 21, 75) - 0.5) * smooth(Y0 - 30, Y0 - 4, uy);
      v += 0.5 * (noise((ux * 194) / CW, uy * 4.4, 23, 194) - 0.5);
      // Each tooth's root shows as a gentle swelling under the gum (the juga), between soft hollows.
      v += 1.6 * S * 0.4 * Math.cos(((ux - C) / CW) * Math.PI * 2) * smooth(2, Y0 - 10, uy) * (1 - smooth(Y0 - 6, Y0 + 2, uy));
      hf[i] = v;
    }
  }
  const color = (x: number, y: number): RGB | null => {
    const i = y * wo + x;
    const uy = y / S;
    // Mucosa high up, coral attached gum, a paler rim at the margin.
    let a = mix(MUCOSA, GUM, smooth(Y0 - 34, Y0 - 14, uy));
    a = mix(a, GUM_MARGIN, 1 - smooth(0, 2.2 * S, dist[i]));
    const m = (noise((((x - P) / S) * 22) / CW, uy * 0.5, 31, 22) - 0.5) * 0.06;
    const n = normalAt(hf, wo, h, x, y, 1);
    const c = shade(n, { albedo: [a[0] + m, a[1] + m * 0.6, a[2] + m * 0.6], gloss: 0.55, wrap: 0.6, ao: 1 }, flipY);
    // The sulcus: a fine darker line where the gum meets the tooth.
    const sulcus = 1 - 0.32 * (1 - smooth(0, 0.9 * S, dist[i]));
    return [c[0] * sulcus, c[1] * sulcus * 0.96, c[2] * sulcus * 0.96];
  };
  /*
    The gum covers the whole root now, the way it does in the mouth: the root
    shows through it, tinted, more toward the top where the tissue is thin,
    and an implant, a root canal or a graft drawn on the root is drawn over it
    and stays plain to see. Nothing sticks out into white space any more.
  */
  const opacityAt = (uy: number) => {
    const t = clamp(uy / PAP);
    const thin = smooth(0, 16, uy);
    return thin * (t < 0.55 ? 0.5 + (t / 0.55) * 0.2 : t < 0.82 ? 0.7 + ((t - 0.55) / 0.27) * 0.26 : 0.96 + ((t - 0.82) / 0.18) * 0.04);
  };
  // Where two tiles overlap, the opacity two layers of which make `a`: 1 − (1 − b)² = a.
  const share = (x: number, a: number) => (x < 2 * P || x >= w ? 1 - Math.sqrt(Math.max(0, 1 - a)) : a);
  const fade = new Float32Array(wo * h);
  const shadow = new Float32Array(wo * h);
  for (let y = 0; y < h; y++) {
    const uy = y / S;
    for (let x = 0; x < wo; x++) {
      const i = y * wo + x;
      fade[i] = share(x, cov[i] * opacityAt(uy));
      // Just below the margin, on the tooth, the soft shadow of the gum over it.
      if (cov[i] < 1 && uy > Y0 - 4) shadow[i] = share(x, (1 - cov[i]) * castShadow * (1 - smooth(0, 2.6 * S, below[i])));
    }
  }
  return {
    w: wo,
    px: await saveArt(dir, name, wo, h, [
      { cov: shadow, color: () => SHADOW },
      { cov: fade, color },
    ]),
  };
}
