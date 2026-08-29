/**
 * Readable ink for an arbitrary background.
 *
 * Service and doctor colours are clinic-editable, so a block can be anything
 * from deep navy to pale blue. Picking the text colour from the background's
 * relative luminance keeps every label legible instead of assuming white.
 */

/*
  Black rather than the app's ink-900 (#16181c), for a measured reason. Paired
  with white, #16181c leaves a band of mid-tones around luminance 0.2 where
  neither ink reaches the 4.5:1 the labels need — the worst case is 4.22:1, and
  violet services land almost exactly on it. Pure black lifts the worst case
  anywhere in the colour space to 4.59:1, so every colour a clinic can pick is
  legible. On a light block the two are all but indistinguishable.
*/
const INK = "#000000";
const WHITE = "#ffffff";

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    // Linearised like the other two. Passing the raw 0-255 byte here inflated
    // the result by up to 255x, so every colour with any blue in it measured
    // as brighter than white and was given dark text — which is why a navy
    // service block was drawn in near-black on near-black, and why pure black
    // was the only dark colour that behaved.
    0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio between two relative luminances, 1 (none) to 21 (max). */
function ratio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Near-black or white, whichever contrasts better with `bg`.
 *
 * Measured rather than thresholded. The flip point between these two inks is a
 * consequence of what they are — it sits near a luminance of 0.2, not at the
 * midpoint — and hard-coding a number invites it drifting out of step with the
 * ink the moment either colour is touched.
 */
export function inkOn(bg: string | null | undefined): string {
  if (!bg || !bg.startsWith("#")) return WHITE;
  const l = luminance(bg);
  return ratio(l, luminance(INK)) >= ratio(l, luminance(WHITE)) ? INK : WHITE;
}
