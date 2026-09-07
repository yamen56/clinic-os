/**
 * The colour a clinic's charts wear, derived from its brand colour.
 *
 * Every workspace used to draw its bars in the same slate blue. That is a
 * defensible default and it is not the clinic's — a practice that has set its
 * brand to teal sees a blue chart on an otherwise teal screen.
 *
 * **The brand colour is not used directly, and that is the whole design.** The
 * default `--color-chart` was chosen by measurement rather than taste: OKLCh
 * chroma 0.106 so it clears the floor below which a hue reads as grey, and 4.3:1
 * against the surface so a label on it stays legible. Real brand colours in this
 * database run from `#0a111f` to `#ffd500` — a near-black that would read as
 * chrome rather than data, and a yellow that fails contrast on a white surface
 * outright. Substituting either one directly produces a chart that is on-brand
 * and unreadable.
 *
 * So the *hue* comes from the clinic and the *lightness and chroma* come from
 * the value that was already validated. Every clinic gets a chart in its own
 * colour, carrying the same weight on the page as the one this replaces.
 */

/** The measured anchors, read off `--color-chart` (#3a6ea5). */
const ANCHOR_L = 0.5;
const ANCHOR_C = 0.106;

/**
 * Below this, a colour has no usable hue.
 *
 * `#0a111f` is 98% of the way to black; the angle its two remaining chroma
 * points happen to make is noise, and rotating a chart to it would be reading
 * meaning into a rounding error. Those clinics keep the default.
 */
const HUE_IS_NOISE_BELOW = 0.03;

/* ---------------------------------------------------------------- sRGB ⇄ OKLab */

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Björn Ottosson's OKLab, the space the lightness and chroma checks are defined in. */
function rgbToOklch(r: number, g: number, b: number): { L: number; C: number; h: number } {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    L,
    C: Math.hypot(a, bb),
    h: (Math.atan2(bb, a) * 180) / Math.PI,
  };
}

function oklchToRgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function inGamut(L: number, C: number, h: number): boolean {
  return oklchToRgb(L, C, h).every((v) => v >= -0.001 && v <= 1.001);
}

/** The most chroma this hue can hold at this lightness inside sRGB. */
function maxChroma(L: number, h: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** WCAG relative luminance, for the contrast floor against the surface. */
function luminance(r: number, g: number, b: number): number {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/**
 * Converts back to a hex that actually exists in sRGB, at a lightness the hue
 * can afford.
 *
 * Not every (L, C, h) is displayable, and the shortfall is not evenly spread:
 * blues and reds reach the target chroma comfortably at mid lightness, while
 * cyans and teals cannot — sRGB simply has less of them there. Fixing lightness
 * and clamping chroma to fit therefore produced a teal at 0.091, under the floor
 * below which a hue starts reading as grey.
 *
 * So lightness moves instead. The dataviz standard allows 0.43–0.77, and within
 * that band this walks outward from the anchor for the first lightness where the
 * hue can carry the target chroma *and* still clear 3:1 against the surface —
 * the two constraints that pull in opposite directions, because the lightness
 * that buys chroma is the lightness that loses contrast.
 *
 * If no lightness satisfies both — true of a pure cyan, which sRGB cannot render
 * saturated and dark at once — it takes the most chroma available at a
 * contrast-safe lightness. That is a real limit of the display, not a shortcut:
 * the alternative is an illegible bar or a grey one.
 */
const SURFACE_LUMINANCE = 1; // #ffffff
const MIN_CONTRAST = 3;

function contrastOnSurface(L: number, C: number, h: number): number {
  const [r, g, b] = oklchToRgb(L, C, h);
  const lum = luminance(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)));
  return (SURFACE_LUMINANCE + 0.05) / (lum + 0.05);
}

function snapToBand(h: number, targetC: number): string {
  let best: { L: number; C: number } | null = null;

  // Outward from the anchor in 0.01 steps, so the result stays as close to the
  // weight of the colour this replaces as the hue permits.
  for (let step = 0; step <= 35; step++) {
    for (const L of step === 0 ? [ANCHOR_L] : [ANCHOR_L - step * 0.01, ANCHOR_L + step * 0.01]) {
      if (L < 0.43 || L > 0.77) continue;
      const avail = maxChroma(L, h);
      const C = Math.min(targetC, avail);
      if (contrastOnSurface(L, C, h) < MIN_CONTRAST) continue;
      if (C >= targetC) {
        const [r, g, b] = oklchToRgb(L, C, h);
        return rgbToHex(r, g, b);
      }
      // Remember the richest fallback in case nothing reaches the target.
      if (!best || C > best.C) best = { L, C };
    }
  }

  const { L, C } = best ?? { L: ANCHOR_L, C: maxChroma(ANCHOR_L, h) };
  const [r, g, b] = oklchToRgb(L, C, h);
  return rgbToHex(r, g, b);
}

/** A plain in-gamut conversion, for the light track where chroma is not the point. */
function toDisplayableHex(L: number, C: number, h: number): string {
  const c = Math.min(C, maxChroma(L, h));
  const [r, g, b] = oklchToRgb(L, c, h);
  return rgbToHex(r, g, b);
}

export type ChartColors = { chart: string; soft: string };

/** What every clinic used before this existed, and the fallback for a hueless brand. */
export const DEFAULT_CHART: ChartColors = { chart: "#3a6ea5", soft: "#e6edf5" };

/**
 * The chart colours for one clinic.
 *
 * `soft` is the same hue at the far light end — it is the empty half of a row
 * bar, so it has to read as a track rather than as data, and it is the one
 * value here allowed to be low-contrast on purpose.
 */
export function chartColorsFor(brandColor: string | null | undefined): ChartColors {
  const rgb = brandColor ? hexToRgb(brandColor) : null;
  if (!rgb) return DEFAULT_CHART;

  const { C, h } = rgbToOklch(rgb[0], rgb[1], rgb[2]);
  // A near-grey or near-black brand has no hue worth borrowing.
  if (C < HUE_IS_NOISE_BELOW) return DEFAULT_CHART;

  return {
    chart: snapToBand(h, ANCHOR_C),
    soft: toDisplayableHex(0.93, 0.03, h),
  };
}
