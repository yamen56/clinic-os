/**
 * The numbers on a chart's scale.
 *
 * Round ones — 0, 250, 500, 750 — because a scale is read by eye against a
 * column, and nobody reads 0, 213, 426. The step is 1, 2, 2.5 or 5 times a
 * power of ten, and the top is the first step at or above the largest value,
 * so the tallest mark never pokes through the top line.
 */
export function niceStep(n: number): number {
  if (!(n > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** Ticks from 0 to a round top, about `count` steps apart. Never fewer than two. */
export function niceTicks(max: number, count = 3): number[] {
  const step = niceStep(max / count);
  const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

/**
 * A smooth line through points that never overshoots them (monotone cubic,
 * Fritsch–Carlson): a quiet day between two busy ones dips to its own value and
 * no lower, so the curve never draws money below zero that nobody lost.
 * Points are in the chart's own 0–100 box; the result is an SVG path.
 */
export function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      t[i] = s * a * m[i];
      t[i + 1] = s * b * m[i];
    }
  }
  const f = (v: number) => +v.toFixed(3);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(pts[i][0] + h)},${f(pts[i][1] + h * t[i])},${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - h * t[i + 1])},${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return d;
}

/** A value as the chart shows it: money to the cent with its currency, or a whole count. */
export function formatValue(n: number, locale: string, currency?: string): string {
  return currency
    ? `${n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
    : n.toLocaleString(locale);
}
