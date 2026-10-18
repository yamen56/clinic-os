"use client";

import { useMemo } from "react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { flowStage, type FlowStage } from "@/lib/patient-flow";
import type { Appt } from "../types";
import { CalendarDays } from "lucide-react";

const stageBadge: Partial<Record<FlowStage, StatusKey>> = {
  waiting: "waiting",
  in_room: "in_room",
  late: "late",
  finished: "completed",
  no_show: "no_show",
};
const statusBadge: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

/**
 * The phone's calendar: a week strip and the chosen day as a list.
 *
 * A time grid on a 390px screen is one narrow column per doctor, scrolled
 * sideways and down at once, with names cut to three letters. The desk on a
 * phone wants the opposite — who is next, with what, in which room — so the
 * day reads as rows in time order, each a full-width tap target, and today's
 * rows carry the one action that matters at the door: Arrived.
 */
export function AgendaList({
  weekStart,
  anchor,
  tz,
  appts,
  nowMs,
  onPickDay,
  onOpen,
  onArrived,
  statusLabel,
}: {
  weekStart: DateTime;
  anchor: DateTime;
  tz: string;
  appts: Appt[];
  nowMs: number;
  onPickDay: (d: DateTime) => void;
  onOpen: (a: Appt) => void;
  onArrived: (a: Appt) => void;
  statusLabel: (s: string) => string;
}) {
  const { t, locale } = useI18n();
  const fmt = locale === "ar" ? "ar" : "en-GB";
  const today = DateTime.fromMillis(nowMs).setZone(tz).toISODate();
  const byDay = useMemo(() => {
    const m = new Map<string, Appt[]>();
    for (const a of appts) {
      const k = DateTime.fromISO(a.starts_at).setZone(tz).toISODate()!;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    return m;
  }, [appts, tz]);
  const days = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));
  const key = anchor.toISODate()!;
  const list = (byDay.get(key) ?? []).slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const isToday = key === today;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid grid-cols-7 gap-1" role="tablist">
        {days.map((d) => {
          const k = d.toISODate()!;
          const n = (byDay.get(k) ?? []).filter((a) => a.status !== "no_show").length;
          const on = k === key;
          return (
            <button
              key={k}
              role="tab"
              aria-selected={on}
              onClick={() => onPickDay(d)}
              className={`flex min-w-0 touch-manipulation flex-col items-center rounded-xl py-1.5 transition-colors duration-140 ${
                on ? "bg-brand-600 text-on-brand shadow-card" : k === today ? "bg-brand-50 text-ink-900" : "text-ink-500 hover:bg-sunken"
              }`}
            >
              <span className="text-[10.5px] font-medium">{d.setLocale(fmt).toFormat("ccc")}</span>
              <span className="text-[15px] font-bold tnum">{d.day}</span>
              <span className={`mt-0.5 h-1.5 w-1.5 rounded-full ${n ? (on ? "bg-white" : "bg-brand-500") : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-card border border-line bg-surface shadow-card">
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center text-ink-500">
            <CalendarDays className="h-7 w-7 text-ink-300" />
            <span className="text-sm">{t.calendar.nothingThisDay}</span>
          </div>
        ) : (
          <ul className="divide-y divide-line max-sm:pb-24" /* room to scroll the last visit clear of the phone's booking button */>
            {list.map((a) => {
              const s = DateTime.fromISO(a.starts_at).setZone(tz);
              const e = DateTime.fromISO(a.ends_at).setZone(tz);
              const stage = flowStage(
                { status: a.status, starts_at: a.starts_at, arrived_at: a.arrived_at ?? null, seated_at: a.seated_at ?? null },
                nowMs
              );
              const room = (locale === "ar" && a.room_name_ar) || a.room_name;
              const service = (locale === "ar" ? a.service_name_ar : null) || a.service_name;
              const canArrive = isToday && (stage === "expected" || stage === "late");
              const badgeKey = stageBadge[stage] ?? statusBadge[a.status] ?? "neutral";
              const badgeText = stageBadge[stage]
                ? (t.flow.stages as Record<string, string>)[stage]
                : statusLabel(a.status);
              return (
                <li key={a.id} data-appt-row={a.id} className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => onOpen(a)}
                    className="flex min-w-0 flex-1 touch-manipulation items-center gap-3 px-3 py-3 text-start active:bg-sunken sm:px-4"
                  >
                    <span className="w-12 shrink-0 text-center">
                      <span className="block text-[14px] font-bold leading-tight text-ink-900 tnum">{s.toFormat("H:mm")}</span>
                      <span className="block text-[11px] text-ink-400 tnum">{e.toFormat("H:mm")}</span>
                    </span>
                    <span className="h-10 w-px shrink-0 bg-line" />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[14px] font-semibold ${a.status === "no_show" ? "text-ink-400 line-through" : "text-ink-900"}`}>
                        {a.patient_name}
                      </span>
                      <span className="block truncate text-[12px] text-ink-500">
                        {[service, a.doctor_name, room].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                    {!canArrive && <Badge status={badgeKey}>{badgeText}</Badge>}
                  </button>
                  {canArrive && (
                    <div className="flex shrink-0 items-center gap-1.5 pe-3 sm:pe-4">
                      {stage === "late" && <Badge status="late">{t.flow.stages.late}</Badge>}
                      <button
                        type="button"
                        onClick={() => onArrived(a)}
                        className="h-9 touch-manipulation rounded-full bg-st-waiting px-3.5 text-[13px] font-semibold text-surface shadow-card active:opacity-80"
                      >
                        {t.flow.arrived}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
