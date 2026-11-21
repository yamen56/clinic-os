/**
 * A magnitude beside a name, for table rows.
 *
 * Shares the scale with every other row in the column — that is the whole
 * point, and the reason `max` is passed in rather than computed per row.
 */
export function RowBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? (Math.max(0, value) / max) * 100 : 0;
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-chart-soft" aria-hidden>
      <span
        data-chart-mark
        className="block h-full rounded-full bg-chart"
        style={{ width: value <= 0 ? 0 : `max(4px, ${pct}%)` }}
      />
    </span>
  );
}

/**
 * One row of a breakdown: a name, its amount, its share of the whole, and a
 * bar on the scale the whole card shares.
 *
 * Ranked, largest first, by the caller — the order is the answer to "what
 * earns", so it is never alphabetical. The share is printed beside the amount
 * rather than drawn as a pie: a column of numbers lines up, slices do not.
 */
export function RankedRow({
  name,
  note,
  amount,
  share,
  value,
  max,
}: {
  name: React.ReactNode;
  /** A quiet aside after the name: "× 12", "4 payments". */
  note?: string;
  /** Already formatted. */
  amount: string;
  /** Whole percent of the card's total, when a total means something. */
  share?: number | null;
  value: number;
  max: number;
}) {
  return (
    <li className="px-5 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-[0.8125rem]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ink-900">{name}</span>
          {note && <span className="shrink-0 text-[0.75rem] text-ink-400 tnum">{note}</span>}
        </span>
        <span className="flex shrink-0 items-baseline gap-2 tnum">
          <span className="font-semibold text-ink-900">{amount}</span>
          {share !== null && share !== undefined && (
            <span className="inline-block w-9 text-end text-[0.75rem] text-ink-400">{share}%</span>
          )}
        </span>
      </div>
      <RowBar value={value} max={max} />
    </li>
  );
}
