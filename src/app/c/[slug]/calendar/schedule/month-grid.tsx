"use client";

import { useMemo } from "react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { tint } from "./grid-layout";
import type { Appt } from "../types";

export function MonthGrid({
  days,
  anchorDt,
  tz,
  appts,
  colorOf,
  blockedDates,
  onDayClick,
}: {
  days: DateTime[];
  anchorDt: DateTime;
  tz: string;
  appts: Appt[];
  colorOf: (a: Appt) => string;
  blockedDates: string[];
  onDayClick: (d: DateTime) => void;
}) {
  const { locale } = useI18n();
  const fmt = locale === "ar" ? "ar" : "en-GB";
  const byDay = useMemo(() => {
    const m = new Map<string, Appt[]>();
    for (const a of appts) {
      const k = DateTime.fromISO(a.starts_at).setZone(tz).toISODate()!;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    return m;
  }, [appts, tz]);
  const today = DateTime.now().setZone(tz).toISODate();
  const busiest = Math.max(1, ...[...byDay.values()].map((l) => l.length));

  return (
    <div className="flex-1 overflow-auto rounded-card border border-line bg-surface shadow-card">
      <div className="sticky top-0 z-[2] grid min-w-[640px] grid-cols-7 border-b border-line bg-surface text-center text-[12px] font-medium text-ink-500">
        {days.slice(0, 7).map((d) => (
          <div key={d.toISO()} className="py-2">
            {d.setLocale(fmt).toFormat("ccc")}
          </div>
        ))}
      </div>
      <div className="grid min-w-[640px] grid-cols-7">
        {days.map((d) => {
          const k = d.toISODate()!;
          const list = byDay.get(k) ?? [];
          const inMonth = d.month === anchorDt.month;
          const blocked = blockedDates.includes(k);
          return (
            <button
              key={k}
              onClick={() => onDayClick(d)}
              className={`group flex min-h-28 flex-col border-b border-e border-line p-1.5 text-start align-top transition-colors hover:bg-brand-50/50 ${
                inMonth ? "" : "bg-subtle text-ink-300"
              } ${blocked ? "bg-[repeating-linear-gradient(135deg,var(--color-danger-soft)_0_6px,transparent_6px_12px)]" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold tnum ${
                    k === today ? "bg-brand-600 text-white" : ""
                  }`}
                >
                  {d.day}
                </span>
                {list.length > 0 && (
                  <span className="text-[10.5px] font-semibold text-ink-400 tnum">{list.length}</span>
                )}
              </div>
              {/* How full the day is, at a glance across the month. */}
              {list.length > 0 && (
                <span className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
                  <span className="block h-full rounded-full bg-brand-500/70" style={{ width: `${(list.length / busiest) * 100}%` }} />
                </span>
              )}
              <div className="mt-1 grid gap-0.5">
                {list.slice(0, 3).map((a) => (
                  <span
                    key={a.id}
                    className="truncate rounded px-1 py-0.5 text-[11px] font-medium text-ink-900"
                    style={{ background: tint(colorOf(a), 18), boxShadow: `inset 2px 0 0 ${colorOf(a)}` }}
                  >
                    <span className="tnum text-ink-500">{DateTime.fromISO(a.starts_at).setZone(tz).toFormat("H:mm")}</span> {a.patient_name}
                  </span>
                ))}
                {list.length > 3 && <span className="text-[11px] text-ink-400 tnum">+{list.length - 3}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
