"use client";

import { useState } from "react";

export type TrendPoint = {
  /** Under the axis, where there is room for it: "3 Nov", "Nov". */
  label: string;
  /** In the readout, in full: "Tuesday 3 November", "Week of 3 November". */
  name: string;
  value: number;
};

/**
 * Money over time, as columns against a scale.
 *
 * `BarChart` in the UI kit is a sparkline with a readout — right for a tile on
 * the front page, and short of what a page about money needs, which is to be
 * able to read an amount off a column without touching it. So this one has a
 * scale: three hairlines, labelled in round numbers.
 *
 * One series, like the kit's, and for its reason: collected and spent are two
 * charts side by side, each on its own scale, never two colours on one axis.
 * Laid out in percentages, so the server draws it whole on first paint.
 */
export function TrendChart({
  data,
  locale,
  currency,
  height = 176,
}: {
  data: TrendPoint[];
  /* A locale tag, not a formatter — a function cannot cross from a server component. */
  locale: string;
  currency: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const money = (n: number) =>
    `${n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });

  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0]);
  const top = niceCeil(Math.max(0, ...data.map((d) => d.value)));
  const active = hover === null ? null : data[hover];
  // First, middle and last: enough to place every column, few enough never to collide.
  const marks = data.length <= 2 ? data.map((_, i) => i) : [0, Math.floor((data.length - 1) / 2), data.length - 1];

  return (
    <div>
      {/*
        The readout is a fixed row above the plot, not a tooltip on the column:
        one that follows the pointer covers the neighbours somebody is hovering
        to compare, and on a phone it lands under the finger. Idle, it names the
        best stretch, so the chart says something untouched.
      */}
      <div className="mb-3 flex h-5 items-baseline gap-2 text-[0.8125rem]" aria-live="polite">
        {active ? (
          <>
            <span className="font-semibold text-ink-900 tnum">{money(active.value)}</span>
            <span className="truncate text-ink-500">{active.name}</span>
          </>
        ) : peak && peak.value > 0 ? (
          <>
            <span className="font-semibold text-ink-900 tnum">{money(peak.value)}</span>
            <span className="truncate text-ink-400">{peak.name}</span>
          </>
        ) : null}
      </div>

      <div className="flex gap-2">
        {/* The scale. Its labels sit on their lines, so the top one rides half a line above the plot. */}
        <div className="relative w-9 shrink-0 text-[length:max(11px,0.6875rem)] text-ink-400 tnum" style={{ height }} aria-hidden>
          {[1, 0.5, 0].map((f) => (
            <span key={f} className="absolute end-0 -translate-y-1/2 leading-none" style={{ top: `${(1 - f) * 100}%` }}>
              {compact.format(top * f)}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1" style={{ height }}>
          {[0, 50, 100].map((pct) => (
            <span key={pct} className="absolute inset-x-0 border-t border-line" style={{ top: `${pct}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]" role="img" onMouseLeave={() => setHover(null)}>
            {data.map((d, i) => (
              <button
                key={i}
                type="button"
                // The whole column is the target, not the bar: a two-pixel bar
                // on a quiet day is otherwise impossible to point at.
                className="flex h-full min-w-0 flex-1 touch-manipulation items-end justify-center outline-none"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => setHover(i)}
                aria-label={`${d.name}: ${money(d.value)}`}
              >
                <span
                  className={`w-full max-w-6 rounded-t-[4px] transition-colors duration-140 ease-out ${
                    hover === i ? "bg-ink-900" : hover === null ? "bg-chart" : "bg-chart/55"
                  }`}
                  // Nothing taken keeps a 2px foot: "a quiet day" and "no data"
                  // must not look alike.
                  style={{ height: d.value <= 0 ? 2 : `max(2px, ${(d.value / top) * 100}%)` }}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative ms-11 mt-2 h-4 text-[length:max(11px,0.6875rem)] text-ink-400" aria-hidden>
        {marks.map((i, n) => (
          <span
            key={i}
            className={`absolute top-0 whitespace-nowrap ${
              n === 0 ? "start-0" : n === marks.length - 1 ? "end-0" : "start-1/2 -translate-x-1/2 rtl:translate-x-1/2"
            }`}
          >
            {data[i]?.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The next round number at or above `n` — 1, 2, 2.5 or 5 times a power of ten. */
function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}
