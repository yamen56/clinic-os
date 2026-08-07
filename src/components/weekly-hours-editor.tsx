"use client";

import { useI18n } from "@/lib/i18n/client";
import { DAY_KEYS } from "@/lib/hours";
import { Plus, X } from "lucide-react";

type Weekly = Record<string, [string, string][]>;

export function WeeklyHoursEditor({
  value,
  onChange,
  disabled,
}: {
  value: Weekly;
  onChange: (v: Weekly) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  const setDay = (day: string, ranges: [string, string][]) =>
    onChange({ ...value, [day]: ranges });

  return (
    /*
      grid-cols-1, not a bare grid: an implicit `auto` column is floored at the
      min-content width of the widest day row, and a row holding two native time
      inputs is wider than a phone. The floor became the page's width and the
      whole of Settings scrolled sideways. See the note in automations-client.
    */
    <div className="grid grid-cols-1 gap-2">
      {DAY_KEYS.map((day) => {
        const ranges = value[day] ?? [];
        return (
          <div key={day} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
            <span className="w-20 shrink-0 text-[13px] font-medium">{(t.hours.days as Record<string, string>)[day]}</span>
            {ranges.length === 0 && <span className="text-[13px] text-ink-400">{t.hours.closed}</span>}
            {ranges.map(([from, to], i) => (
              // A native time input carries its own intrinsic width, and two of
              // them plus the separator will not fit beside the day name on a
              // narrow phone. Let the pair wrap onto its own line rather than
              // hold the row open.
              <span key={i} className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1">
                <input
                  type="time"
                  value={from}
                  disabled={disabled}
                  onChange={(e) => {
                    const next = [...ranges] as [string, string][];
                    next[i] = [e.target.value, to];
                    setDay(day, next);
                  }}
                  className="bg-transparent text-[13px] tnum outline-none"
                />
                <span className="text-ink-400">–</span>
                <input
                  type="time"
                  value={to}
                  disabled={disabled}
                  onChange={(e) => {
                    const next = [...ranges] as [string, string][];
                    next[i] = [from, e.target.value];
                    setDay(day, next);
                  }}
                  className="bg-transparent text-[13px] tnum outline-none"
                />
                {!disabled && (
                  <button
                    aria-label={t.common.delete}
                    onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}
                    className="text-ink-300 hover:text-danger"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            ))}
            {!disabled && (
              <button
                onClick={() => setDay(day, [...ranges, ranges.length ? ["14:00", "18:00"] : ["09:00", "17:00"]] as [string, string][])}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-brand-700 hover:bg-brand-50"
              >
                <Plus className="h-3.5 w-3.5" />
                {t.hours.addRange}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
