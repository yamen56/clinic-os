import { monotonePath } from "./scale";

/**
 * A week's shape in a line, for the corner of a figure card.
 *
 * No scale and no readout: it answers "is this going up?" at a glance and
 * leaves the number to the card. Drawn in the clinic's chart colour with a
 * soft wash under it; mirrored in Arabic, where time runs right to left.
 * Server-rendered, no state.
 */
export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values.map((v) => Math.max(0, v)));
  const n = values.length;
  // A little air at the top and bottom, so the line never rides the edge.
  const pts: [number, number][] = values.map((v, i) => [(i / (n - 1)) * 100, 94 - (Math.max(0, v) / max) * 84]);
  const line = monotonePath(pts);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={`block w-full overflow-visible rtl:-scale-x-100 ${className}`} aria-hidden>
      <path d={`${line}L100,100L0,100Z`} className="fill-chart" fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        className="stroke-chart"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        data-chart-mark
      />
    </svg>
  );
}
