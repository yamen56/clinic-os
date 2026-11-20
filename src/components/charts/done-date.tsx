"use client";

/*
  The day a done entry was done, changeable (Yamen, 2026-11-20: work is often
  written down after the day it was done). One date box, today at the latest,
  in the clinic's own calendar; the entry moves to that day's visit when the
  patient had one (lib/charts/redate.ts).
*/

import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { todayIn } from "@/lib/dates";

export function DoneDateField({
  doneAt,
  tz,
  disabled,
  onChange,
  label,
}: {
  doneAt: string | null;
  tz: string;
  disabled?: boolean;
  onChange: (day: string) => void;
  /** The chart's own words; defaults to the shared "Date done". */
  label?: string;
}) {
  const { t } = useI18n();
  const day = doneAt ? DateTime.fromISO(doneAt).setZone(tz).toISODate()! : todayIn(tz);
  return (
    <label className="block" data-done-date={day}>
      <span className="mb-1 block text-[12px] font-semibold text-ink-500">{label ?? t.common.dateDone}</span>
      <input
        type="date"
        dir="ltr"
        disabled={disabled}
        value={day}
        max={todayIn(tz)}
        onChange={(e) => {
          const v = e.target.value;
          if (v && v !== day && v <= todayIn(tz)) onChange(v);
        }}
        className="h-9 w-full rounded-ctl border border-line bg-surface px-3 text-base disabled:bg-subtle md:text-sm"
      />
    </label>
  );
}
