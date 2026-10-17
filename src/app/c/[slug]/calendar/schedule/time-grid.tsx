"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { hmToMin, rangesForDay, type WeeklyHours } from "@/lib/hours";
import { useI18n } from "@/lib/i18n/client";
import { ApptCard } from "./appt-card";
import { layoutLanes, visibleRange, PX, SNAP } from "./grid-layout";
import { DoorOpen } from "lucide-react";
import type { Appt } from "../types";

export type GridColumn = {
  key: string;
  day: DateTime;
  /** What a column is: a whole day (week view), or one doctor's or one room's day. */
  kind: "day" | "doctor" | "room";
  /** The doctor or room this column is for; null is the "none" column. */
  ownerId?: string | null;
  hours: WeeklyHours;
  label: string;
  color?: string;
};

export type MoveChange = { doctorId?: string | null; roomId?: string | null };

/** How long a finger rests on a visit before it lifts for dragging. */
const LONG_PRESS_MS = 350;

type Drag = {
  appt: Appt;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  colIndex: number;
  origStart: DateTime;
  origEnd: DateTime;
  moved: boolean;
  /** A mouse drags at once; a finger only after the long press. */
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
type Preview = { apptId: string; start: DateTime; end: DateTime; colIndex: number };

export function TimeGrid({
  columns,
  tz,
  blockedDates,
  appts,
  colorOf,
  nowMs,
  showRoom,
  scrollKey,
  onEmptyClick,
  onApptClick,
  onApptMoved,
  statusLabel,
}: {
  columns: GridColumn[];
  tz: string;
  blockedDates: string[];
  /** Not cancelled; filtered already. */
  appts: Appt[];
  colorOf: (a: Appt) => string;
  nowMs: number;
  showRoom: boolean;
  /** Changes when the period changes, to scroll the grid to now again. */
  scrollKey: string;
  onEmptyClick: (start: DateTime, col: GridColumn) => void;
  onApptClick: (a: Appt) => void;
  onApptMoved: (a: Appt, s: DateTime, e: DateTime, change: MoveChange) => void;
  statusLabel: (s: string) => string;
}) {
  const { locale } = useI18n();
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const now = DateTime.fromMillis(nowMs).setZone(tz);
  const fmt = locale === "ar" ? "ar" : "en-GB";

  const { startMin, endMin } = useMemo(
    () =>
      visibleRange(
        [...new Set(columns.map((c) => c.hours))],
        [...new Set(columns.map((c) => c.day.toISODate()!))].map((d) => DateTime.fromISO(d, { zone: tz })),
        appts,
        tz
      ),
    [columns, appts, tz]
  );
  const totalH = (endMin - startMin) * PX;
  const minOf = (d: DateTime) => d.hour * 60 + d.minute;

  const belongs = (a: Appt, col: GridColumn) => {
    const s = DateTime.fromISO(a.starts_at).setZone(tz);
    if (s.toISODate() !== col.day.toISODate()) return false;
    if (col.kind === "doctor") return col.ownerId ? a.doctor_member_id === col.ownerId : !a.doctor_member_id;
    if (col.kind === "room") return col.ownerId ? a.room_id === col.ownerId : !a.room_id;
    return true;
  };

  /* ---------------- drag ---------------- */
  const drag = useRef<Drag | null>(null);
  const [preview, setPreviewState] = useState<Preview | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const setPreview = (p: Preview | null) => {
    previewRef.current = p;
    setPreviewState(p);
  };
  const colsRef = useRef(columns);
  colsRef.current = columns;
  const cb = useRef({ onApptMoved, onApptClick });
  cb.current = { onApptMoved, onApptClick };

  const begin = (ev: React.PointerEvent, a: Appt, mode: Drag["mode"], ci: number) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const mouse = ev.pointerType === "mouse";
    if (mouse) ev.preventDefault();
    if (mode === "resize") ev.stopPropagation();
    const d: Drag = {
      appt: a,
      mode,
      startX: ev.clientX,
      startY: ev.clientY,
      colIndex: ci,
      origStart: DateTime.fromISO(a.starts_at).setZone(tz),
      origEnd: DateTime.fromISO(a.ends_at).setZone(tz),
      moved: false,
      active: mouse,
      timer: null,
    };
    if (!mouse) {
      d.timer = setTimeout(() => {
        if (drag.current !== d) return;
        d.active = true;
        try {
          navigator.vibrate?.(12);
        } catch {}
        setPreview({ apptId: a.id, start: d.origStart, end: d.origEnd, colIndex: ci });
      }, LONG_PRESS_MS);
    }
    drag.current = d;
  };

  useEffect(() => {
    const colWidth = () => {
      const el = gridRef.current;
      return el ? el.scrollWidth / Math.max(colsRef.current.length, 1) : 1;
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dy = e.clientY - d.startY;
      const dx = e.clientX - d.startX;
      if (!d.active) {
        // A finger that moves before the long press is scrolling, not dragging.
        if (Math.abs(dy) > 8 || Math.abs(dx) > 8) {
          if (d.timer) clearTimeout(d.timer);
          drag.current = null;
        }
        return;
      }
      if (Math.abs(dy) > 4 || Math.abs(dx) > 8) d.moved = true;
      if (!d.moved) return;
      const cols = colsRef.current;
      const dMin = Math.round(dy / PX / SNAP) * SNAP;
      const rtl = document.documentElement.dir === "rtl";
      const dCol = Math.round((rtl ? -dx : dx) / colWidth());
      const colIndex = Math.min(Math.max(d.colIndex + dCol, 0), cols.length - 1);
      if (d.mode === "move") {
        const dur = d.origEnd.diff(d.origStart, "minutes").minutes;
        let start = d.origStart.plus({ minutes: dMin });
        // Across days in the week view: keep the time of day.
        if (cols[colIndex].kind === "day" && colIndex !== d.colIndex) {
          start = cols[colIndex].day.set({ hour: start.hour, minute: start.minute });
        }
        setPreview({ apptId: d.appt.id, start, end: start.plus({ minutes: dur }), colIndex });
      } else {
        const end = d.origEnd.plus({ minutes: dMin });
        if (end.diff(d.origStart, "minutes").minutes >= SNAP) {
          setPreview({ apptId: d.appt.id, start: d.origStart, end, colIndex: d.colIndex });
        }
      }
    };
    const finish = (cancelled: boolean) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.timer) clearTimeout(d.timer);
      const p = previewRef.current;
      setPreview(null);
      if (cancelled) return;
      if (d.active && d.moved && p) {
        const cols = colsRef.current;
        const target = cols[p.colIndex];
        const change: MoveChange = {};
        if (p.colIndex !== d.colIndex && target.kind === "doctor") change.doctorId = target.ownerId ?? null;
        // Into a room's column: that room. The "no room" column is not a choice
        // when the clinic has rooms, so dropping there keeps the room it had.
        if (p.colIndex !== d.colIndex && target.kind === "room" && target.ownerId) change.roomId = target.ownerId;
        cb.current.onApptMoved(d.appt, p.start, p.end, change);
      } else if (!d.moved) {
        cb.current.onApptClick(d.appt);
      }
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    // Non-passive, so a lifted visit can be dragged without the page scrolling under it.
    const onTouchMove = (e: TouchEvent) => {
      if (drag.current?.active) e.preventDefault();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  /* Opens on now (or the start of the day), and again when the period changes. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const today = columns.some((c) => c.day.toISODate() === now.toISODate());
    const nowMin = minOf(now);
    el.scrollTop = today && nowMin > startMin && nowMin < endMin ? Math.max(0, (nowMin - startMin) * PX - el.clientHeight / 3) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, startMin]);

  const nowMin = minOf(now);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto rounded-card border border-line bg-surface shadow-card [overscroll-behavior:contain]">
      <div className="flex min-w-fit">
        {/* time gutter */}
        <div className="sticky start-0 z-10 w-12 shrink-0 border-e border-line bg-surface sm:w-14">
          <div className="sticky top-0 z-10 h-11 border-b border-line bg-surface" />
          <div className="relative" style={{ height: totalH }}>
            {Array.from({ length: (endMin - startMin) / 60 }, (_, i) => (
              <span
                key={i}
                className="absolute inline-block w-full pe-1.5 text-end text-[10.5px] text-ink-400 tnum"
                style={{ top: i * 60 * PX - 7 }}
              >
                {i === 0 ? "" : DateTime.fromObject({ hour: startMin / 60 + i }).setLocale("en-GB").toFormat("h a")}
              </span>
            ))}
          </div>
        </div>

        <div ref={gridRef} className="flex flex-1">
          {columns.map((col, ci) => {
            const isToday = col.day.toISODate() === now.toISODate();
            const blocked = blockedDates.includes(col.day.toISODate()!);
            const ranges = rangesForDay(col.hours, col.day);
            const mine = appts.filter((a) => (preview?.apptId === a.id ? preview.colIndex === ci : belongs(a, col)));
            const placed = mine.map((a) => {
              const p = preview?.apptId === a.id ? preview : null;
              const s = p ? p.start : DateTime.fromISO(a.starts_at).setZone(tz);
              const e = p ? p.end : DateTime.fromISO(a.ends_at).setZone(tz);
              return { a, s, e, lifted: !!p };
            });
            const lanes = layoutLanes(placed.map((x) => ({ id: x.a.id, start: minOf(x.s), end: Math.max(minOf(x.e), minOf(x.s) + 15) })));
            const count = appts.filter((a) => belongs(a, col) && a.status !== "no_show").length;
            return (
              <div
                key={col.key}
                data-col={col.kind === "day" ? col.day.toISODate() : col.label}
                className={`flex-1 border-e border-line last:border-e-0 ${col.kind === "day" ? "min-w-[6.5rem]" : "min-w-[9.5rem]"}`}
              >
                {/* header */}
                <div
                  className={`sticky top-0 z-[8] flex h-11 items-center justify-center gap-1.5 border-b border-line px-1.5 text-[12px] font-medium ${
                    isToday && col.kind === "day" ? "bg-brand-50 text-ink-900" : "bg-surface text-ink-500"
                  }`}
                >
                  {col.kind === "day" ? (
                    <>
                      <span>{col.day.setLocale(fmt).toFormat("ccc")}</span>
                      <span
                        className={`grid h-6 min-w-6 place-items-center rounded-full px-1 text-[12.5px] font-semibold tnum ${
                          isToday ? "bg-brand-600 text-white" : "text-ink-900"
                        }`}
                      >
                        {col.day.day}
                      </span>
                      {count > 0 && <span className="text-[11px] text-ink-400 tnum">· {count}</span>}
                    </>
                  ) : (
                    <>
                      {col.kind === "room" && col.ownerId && (
                        <DoorOpen className="h-3.5 w-3.5 shrink-0 text-ink-400" strokeWidth={1.75} aria-hidden />
                      )}
                      <span className="truncate font-semibold text-ink-900">{col.label}</span>
                      {count > 0 && (
                        <span className="rounded-full bg-sunken px-1.5 text-[11px] font-semibold text-ink-500 tnum">{count}</span>
                      )}
                    </>
                  )}
                </div>
                {/* body */}
                <div
                  className={`relative ${blocked ? "bg-[repeating-linear-gradient(135deg,var(--color-danger-soft)_0_6px,transparent_6px_12px)]" : ""}`}
                  style={{ height: totalH }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("[data-appt]")) return;
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const min = startMin + Math.floor((e.clientY - rect.top) / PX / SNAP) * SNAP;
                    onEmptyClick(col.day.startOf("day").plus({ minutes: min }), col);
                  }}
                >
                  {/* closed hours, including a midday break */}
                  {ranges.length === 0 ? (
                    <div className="absolute inset-0 bg-ink-900/4" />
                  ) : (
                    [
                      [startMin, hmToMin(ranges[0][0])],
                      ...ranges.slice(1).map((r, i) => [hmToMin(ranges[i][1]), hmToMin(r[0])]),
                      [hmToMin(ranges[ranges.length - 1][1]), endMin],
                    ]
                      .filter(([a, b]) => b > a)
                      .map(([a, b], i) => (
                        <div
                          key={i}
                          className="absolute inset-x-0 bg-ink-900/4"
                          style={{ top: Math.max(0, (a - startMin) * PX), height: (Math.min(b, endMin) - Math.max(a, startMin)) * PX }}
                        />
                      ))
                  )}
                  {/* hour and half-hour lines */}
                  {Array.from({ length: (endMin - startMin) / 30 }, (_, i) => (
                    <div
                      key={i}
                      className={`pointer-events-none absolute inset-x-0 border-t ${i % 2 === 0 ? "border-line/80" : "border-dashed border-line/40"}`}
                      style={{ top: i * 30 * PX }}
                    />
                  ))}
                  {/* now */}
                  {isToday && nowMin > startMin && nowMin < endMin && (
                    <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (nowMin - startMin) * PX }}>
                      {ci === 0 || col.kind === "day" ? <span className="absolute -top-[5px] start-0 h-2 w-2 rounded-full bg-danger" /> : null}
                    </div>
                  )}
                  {placed.map(({ a, s, e, lifted }) => {
                    const l = lanes.get(a.id) ?? { lane: 0, lanes: 1 };
                    return (
                      <ApptCard
                        key={a.id}
                        appt={a}
                        top={(minOf(s) - startMin) * PX}
                        height={Math.max(e.diff(s, "minutes").minutes * PX, 20)}
                        lane={l.lane}
                        lanes={l.lanes}
                        color={colorOf(a)}
                        tz={tz}
                        locale={locale}
                        showDoctor={col.kind !== "doctor"}
                        showRoom={showRoom && col.kind !== "room"}
                        nowMs={nowMs}
                        lifted={lifted}
                        statusLabel={statusLabel(a.status)}
                        onPointerDown={(ev) => {
                          if ((ev.target as HTMLElement).dataset.resize) return;
                          begin(ev, a, "move", ci);
                        }}
                        onResizeDown={(ev) => begin(ev, a, "resize", ci)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
