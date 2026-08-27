"use client";

import { useState } from "react";

export type Point = { label: string; value: number; sub?: string };

/**
 * A count over time, as bars.
 *
 * Single series, always — and that is the design rather than a limitation. Two
 * measures of different scale on one axis is the commonest way a chart lies,
 * and the fix is two charts, so this component only knows how to draw one
 * thing. Putting patients and messages side by side means rendering it twice.
 *
 * Laid out in percentages rather than a measured pixel width so it fills
 * whatever column it lands in without a resize observer, and so the server can
 * render the whole thing on first paint.
 */
export function BarChart({
  data,
  locale = "en-GB",
  height = 88,
}: {
  data: Point[];
  /*
    A locale tag, not a formatter.

    This is rendered from a server component, and a function cannot cross that
    boundary — React serialises the props, and a closure has no serialisation.
    Passing the tag and calling toLocaleString here does the same job on the
    side of the boundary that can actually do it.
  */
  locale?: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const format = (n: number) => n.toLocaleString(locale);
  const max = Math.max(1, ...data.map((d) => d.value));
  const active = hover === null ? null : data[hover];

  return (
    <div className="relative">
      {/*
        The readout sits above the plot in a fixed row rather than floating over
        a bar. A tooltip that follows the cursor covers the neighbouring bars —
        the exact comparison somebody is hovering to make — and on a touch
        screen it lands under the finger.
      */}
      <div className="mb-1.5 flex h-5 items-baseline gap-2 text-[12px]">
        {active ? (
          <>
            <span className="font-semibold tabular-nums text-ink-900">{format(active.value)}</span>
            <span className="text-ink-400">{active.sub ?? active.label}</span>
          </>
        ) : (
          <span className="text-ink-400">
            {/* Idle state names the peak, so the chart says something without
                being touched. */}
            {(() => {
              const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0]);
              return peak ? `${format(peak.value)} · ${peak.sub ?? peak.label}` : "";
            })()}
          </span>
        )}
      </div>

      <div className="flex items-end gap-[2px]" style={{ height }} role="img">
        {data.map((d, i) => {
          const h = (d.value / max) * 100;
          return (
            <button
              key={i}
              type="button"
              // The hit target is the full column height, not the bar: a
              // two-pixel bar in a quiet month is otherwise unhoverable.
              className="group relative flex h-full flex-1 items-end"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${d.sub ?? d.label}: ${format(d.value)}`}
            >
              <span
                className={`w-full rounded-t-[4px] transition-colors ${
                  hover === i ? "bg-ink-900" : "bg-chart"
                }`}
                // A zero-height bar is indistinguishable from a missing one, so
                // an empty month keeps a 2px foot: "nothing happened" and "no
                // data" have to look different.
                style={{ height: d.value === 0 ? 2 : `max(2px, ${h}%)` }}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-1 flex justify-between text-[11px] text-ink-400">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/**
 * A magnitude beside a name, for table rows.
 *
 * Shares the scale with every other row in the column — that is the whole
 * point, and the reason `max` is passed in rather than computed per row.
 */
export function RowBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <span className="block h-1 w-full rounded-full bg-chart-soft" aria-hidden>
      <span
        className="block h-full rounded-full bg-chart"
        style={{ width: value === 0 ? 0 : `max(3px, ${pct}%)` }}
      />
    </span>
  );
}
