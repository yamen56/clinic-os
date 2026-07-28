/**
 * Readable ink for an arbitrary background.
 *
 * Service and doctor colours are clinic-editable, so a block can be anything
 * from deep navy to pale blue. Picking the text colour from the background's
 * relative luminance keeps every label legible instead of assuming white.
 */

const INK = "#16181c";
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
    0.0722 * (n & 255)
  );
}

/** Near-black or white, whichever contrasts better with `bg`. */
export function inkOn(bg: string | null | undefined): string {
  if (!bg || !bg.startsWith("#")) return WHITE;
  // 0.45 sits between the palette's mid tones, matching the perceptual flip point.
  return luminance(bg) > 0.45 ? INK : WHITE;
}
