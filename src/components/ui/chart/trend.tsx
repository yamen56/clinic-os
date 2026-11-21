"use client";

import { useId, useState } from "react";
import { formatValue, monotonePath, niceTicks } from "./scale";

export type ChartPoint = {
  /** Under the axis, where there is room for it: "3 Nov", "Nov". */
  label: string;
  /** In the readout, in full: "Tuesday 3 November". Falls back to the label. */
  name?: string;
  value: number;
};

type Common = {
  data: ChartPoint[];
  /** What the chart shows, for a screen reader ("Collected, by day"). */
  label: string;
  /*
    A locale tag and a currency code, not a formatter: these are rendered from
    server components, and a function cannot cross that boundary.
  */
  locale: string;
  /** Given, the values are money: two decimals and the code in the readout. */
  currency?: string;
  /** Plot height in px at a 16px root; drawn in rem, so it follows the density. */
  height?: number;
  /**
   * A small multiple: no scale, a baseline only, a shorter plot. For a row of
   * charts side by side that are read for their shape, not their values.
   */
  compact?: boolean;
};

/**
 * Over time, as a line with a soft wash under it.
 *
 * For a figure that flows — money taken day by day — where the shape of the
 * stretch is the point. One series, always: two measures on one axis is the
 * commonest way a chart lies, so collected and spent are two charts.
 *
 * Drawn in SVG in a 0–100 box stretched to its column, so the server paints it
 * whole on first load and it fills any width without measuring. Lines keep a
 * 2px stroke whatever the stretch (`vector-effect`); the dot, the crosshair and
 * every word are HTML over the top, so nothing is squashed. Arabic runs time
 * right to left: the drawing is mirrored and everything else is placed with
 * logical sides.
 *
 * Fewer than four points draw as columns — a line between two dots says less
 * than two bars.
 */
export function AreaTrend(props: Common) {
  if (props.data.length < 4) return <ColumnChart {...props} />;
  return <Frame {...props} kind="area" />;
}

/**
 * Over time, as columns.
 *
 * For counts, and for money that arrives in lumps — a month's rent, a lab bill
 * — where each day stands on its own rather than flowing into the next.
 */
export function ColumnChart(props: Common) {
  return <Frame {...props} kind="columns" />;
}

function Frame({
  data,
  label,
  locale,
  currency,
  height,
  compact = false,
  kind,
}: Common & { kind: "area" | "columns" }) {
  const gradient = useId();
  const [hover, setHover] = useState<number | null>(null);
  const values = data.map((d) => Math.max(0, d.value));
  const max = Math.max(0, ...values);
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1];
  const n = data.length;
  const h = height ?? (compact ? 88 : 192);
  const fmt = (v: number) => formatValue(v, locale, currency);
  const axis = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });

  // Each point sits in the middle of its band, which is also its hit target's middle.
  const xOf = (i: number) => ((i + 0.5) / n) * 100;
  const yOf = (v: number) => 100 - (v / top) * 100;

  const peakIdx = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
  const shown = hover ?? (values[peakIdx] > 0 ? peakIdx : null);
  const active = shown === null ? null : data[shown];
  // First, middle and last: enough to place every point, few enough never to collide.
  const marks = n <= 2 ? data.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];

  const pts: [number, number][] = values.map((v, i) => [xOf(i), yOf(v)]);
  const line = kind === "area" ? monotonePath(pts) : "";
  const area = kind === "area" ? `${line}L${xOf(n - 1)},100L${xOf(0)},100Z` : "";

  return (
    <div onMouseLeave={() => setHover(null)}>
      {/*
        The readout is a fixed row above the plot, not a tooltip on the mark:
        one that follows the pointer covers the neighbours somebody is hovering
        to compare, and on a phone it lands under the finger. Idle, it names
        the best point, so the chart says something before it is touched. The
        value leads; what it is follows in a quieter ink.
      */}
      <div className={`flex h-5 items-baseline gap-2 ${compact ? "mb-1.5 text-[0.75rem]" : "mb-3 text-[0.8125rem]"}`} aria-live="polite">
        {active && (
          <>
            <span className="font-semibold text-ink-900 tnum">{fmt(Math.max(0, active.value))}</span>
            <span className={`truncate ${hover === null ? "text-ink-400" : "text-ink-500"}`}>{active.name ?? active.label}</span>
          </>
        )}
      </div>

      <div className="flex gap-2">
        {!compact && (
          // The scale. Its labels sit on their lines, so the top one rides half a line above the plot.
          <div className="relative w-9 shrink-0 text-[length:max(11px,0.6875rem)] text-ink-400 tnum" style={{ height: `${h / 16}rem` }} aria-hidden>
            {ticks.map((v) => (
              <span key={v} className="absolute end-0 -translate-y-1/2 leading-none" style={{ top: `${yOf(v)}%` }}>
                {axis.format(v)}
              </span>
            ))}
          </div>
        )}

        <div className="relative min-w-0 flex-1" style={{ height: `${h / 16}rem` }}>
          <div
            role="img"
            aria-label={active ? `${label}. ${fmt(Math.max(0, values[peakIdx]))}, ${data[peakIdx].name ?? data[peakIdx].label}` : label}
            className="absolute inset-0"
          >
            {/* Hairlines, solid and quiet: the data is the only thing allowed to be loud. */}
            {(compact ? [0] : ticks).map((v) => (
              <span
                key={v}
                className={`absolute inset-x-0 border-t ${v === 0 ? "border-line-strong" : "border-line"}`}
                style={{ top: `${yOf(v)}%` }}
                aria-hidden
              />
            ))}

            {kind === "area" ? (
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full overflow-visible rtl:-scale-x-100"
                aria-hidden
              >
                <defs>
                  <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: "var(--color-chart)", stopOpacity: 0.18 }} />
                    <stop offset="100%" style={{ stopColor: "var(--color-chart)", stopOpacity: 0.02 }} />
                  </linearGradient>
                </defs>
                <path d={area} fill={`url(#${gradient})`} />
                <path
                  d={line}
                  fill="none"
                  className="stroke-chart"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  data-chart-mark
                />
              </svg>
            ) : (
              <div className="absolute inset-0 flex items-end gap-[2px]" aria-hidden>
                {values.map((v, i) => (
                  <span key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
                    <span
                      data-chart-mark
                      className={`w-full max-w-6 rounded-t-[4px] transition-colors duration-140 ease-out ${
                        hover === null || hover === i ? "bg-chart" : "bg-chart/45"
                      }`}
                      // Nothing that day keeps a 2px foot: "a quiet day" and "no data" must not look alike.
                      style={{ height: v <= 0 ? 2 : `max(2px, ${(v / top) * 100}%)` }}
                    />
                  </span>
                ))}
              </div>
            )}

            {kind === "area" && shown !== null && (
              <>
                {hover !== null && (
                  <span
                    className="absolute inset-y-0 w-px -translate-x-1/2 bg-ink-300 rtl:translate-x-1/2"
                    style={{ insetInlineStart: `${xOf(shown)}%` }}
                    aria-hidden
                  />
                )}
                {/* The dot wears a ring in the card's colour, so it reads where it crosses the line. */}
                <span
                  className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-chart ring-2 ring-surface rtl:translate-x-1/2"
                  style={{ insetInlineStart: `${xOf(shown)}%`, top: `${yOf(values[shown])}%` }}
                  aria-hidden
                />
              </>
            )}
          </div>

          {/*
            The hit targets: a whole band each, not the mark, because a two-pixel
            column on a quiet day is otherwise impossible to point at. Beside the
            drawing, not inside it — what sits inside role="img" is hidden from
            a screen reader, and these are how one reads the values.
          */}
          <div className="absolute inset-0 flex">
            {data.map((d, i) => (
              <button
                key={i}
                type="button"
                className="h-full min-w-0 flex-1 touch-manipulation outline-none focus-visible:bg-ink-900/5"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => setHover(i)}
                aria-label={`${d.name ?? d.label}: ${fmt(Math.max(0, d.value))}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className={`relative mt-2 h-4 text-[length:max(11px,0.6875rem)] text-ink-400 ${compact ? "" : "ms-11"}`} aria-hidden>
        {marks.map((i, k) => (
          <span
            key={i}
            className={`absolute top-0 whitespace-nowrap ${
              k === 0 ? "start-0" : k === marks.length - 1 ? "end-0" : "start-1/2 -translate-x-1/2 rtl:translate-x-1/2"
            }`}
          >
            {data[i]?.label}
          </span>
        ))}
      </div>
    </div>
  );
}
