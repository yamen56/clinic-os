"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { effectiveHours } from "@/lib/hours";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { updateAppointmentAction } from "../actions";
import { scheduleErrorText, savedText } from "../messages";
import { TimeGrid, type GridColumn, type MoveChange } from "./time-grid";
import { MonthGrid } from "./month-grid";
import { AgendaList } from "./agenda-list";
import type { Appt, CalendarData, ScheduleState, ScheduleView as View } from "../types";
import { ChevronLeft, ChevronRight, DoorOpen } from "lucide-react";

/**
 * The Schedule tab: the clinic's diary by day, week or month, or — the phone's
 * default — as a list.
 *
 * Its view, date and filters live in the page (ScheduleState), so stepping
 * over to the waiting room and back lands on the same Thursday.
 */
export function ScheduleView({
  slug,
  tz,
  isDoctor,
  state,
  setState,
  nowMs,
  version,
  canSetUpRooms,
  onData,
  onOpen,
  onCreate,
  onArrived,
}: {
  slug: string;
  tz: string;
  isDoctor: boolean;
  state: ScheduleState;
  setState: (patch: Partial<ScheduleState>) => void;
  nowMs: number;
  /** Bumped by the page after a save elsewhere, to re-read. */
  version: number;
  canSetUpRooms: boolean;
  onData: (d: CalendarData) => void;
  onOpen: (a: Appt) => void;
  onCreate: (start: DateTime, owner: { doctorId?: string | null; roomId?: string | null }) => void;
  onArrived: (a: Appt) => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [data, setData] = useState<CalendarData | null>(null);
  const { view, anchor, doctorFilter, serviceFilter, sectionFilter, colorBy, groupBy } = state;
  const anchorDt = useMemo(() => DateTime.fromISO(anchor, { zone: tz }), [anchor, tz]);

  const range = useMemo(() => {
    if (view === "day") return { start: anchorDt.startOf("day"), days: 1 };
    if (view === "week" || view === "list") {
      // Week starts Sunday (Jordan work week)
      return { start: anchorDt.startOf("day").minus({ days: anchorDt.weekday % 7 }), days: 7 };
    }
    const first = anchorDt.startOf("month");
    return { start: first.minus({ days: first.weekday % 7 }), days: 42 };
  }, [anchorDt, view]);

  const refetch = useCallback(async () => {
    const from = range.start.toUTC().toISO();
    const to = range.start.plus({ days: range.days }).toUTC().toISO();
    const res = await fetch(`/api/c/${slug}/appointments?from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`);
    if (!res.ok) return;
    const d = (await res.json()) as CalendarData;
    setData(d);
    onData(d);
  }, [slug, range, onData]);

  useEffect(() => {
    void refetch();
  }, [refetch, version]);
  useRealtimeRefresh(slug, ["appointments", "clinic_rooms"], refetch);

  const days = useMemo(() => Array.from({ length: range.days }, (_, i) => range.start.plus({ days: i })), [range]);

  const visible = useMemo(() => {
    if (!data) return [];
    return data.appointments.filter(
      (a) =>
        a.status !== "cancelled" &&
        (!doctorFilter || a.doctor_member_id === doctorFilter) &&
        (!sectionFilter || a.service_section_id === sectionFilter) &&
        (!serviceFilter || a.service_id === serviceFilter)
    );
  }, [data, doctorFilter, sectionFilter, serviceFilter]);

  const filterServices = useMemo(
    () => (!data ? [] : sectionFilter ? data.services.filter((s) => s.section_id === sectionFilter) : data.services),
    [data, sectionFilter]
  );

  const colorOf = useCallback(
    (a: Appt) =>
      colorBy === "doctor" ? a.doctor_color ?? "var(--color-ink-400)" : a.service_color ?? "var(--color-brand-500)",
    [colorBy]
  );
  const statusLabel = (s: string) => (t.calendar.statuses as Record<string, string>)[s] ?? s;
  const hasRooms = !!data && data.rooms.length > 0;
  const byRoom = hasRooms && groupBy === "room";

  const nav = (dir: -1 | 1) => {
    const unit = view === "day" ? { days: 1 } : view === "month" ? { months: 1 } : { weeks: 1 };
    setState({ anchor: (dir === 1 ? anchorDt.plus(unit) : anchorDt.minus(unit)).toISODate()! });
  };

  const columns: GridColumn[] = useMemo(() => {
    if (!data) return [];
    if (view !== "day") return days.map((d) => ({ key: d.toISODate()!, day: d, kind: "day" as const, hours: data.clinicHours, label: "" }));
    const day = anchorDt.startOf("day");
    const dayKey = day.toISODate();
    const onDay = visible.filter((a) => DateTime.fromISO(a.starts_at).setZone(tz).toISODate() === dayKey);
    if (byRoom) {
      const cols: GridColumn[] = data.rooms.map((r) => ({
        key: r.id,
        day,
        kind: "room" as const,
        ownerId: r.id,
        hours: data.clinicHours,
        label: (locale === "ar" && r.name_ar) || r.name,
        color: r.color,
      }));
      if (onDay.some((a) => !a.room_id)) {
        cols.push({ key: "none", day, kind: "room", ownerId: null, hours: data.clinicHours, label: t.flow.noRoom });
      }
      return cols;
    }
    const docs = doctorFilter ? data.doctors.filter((d) => d.id === doctorFilter) : data.doctors;
    if (!docs.length) return [{ key: "all", day, kind: "day" as const, hours: data.clinicHours, label: "" }];
    const cols: GridColumn[] = docs.map((d) => ({
      key: d.id,
      day,
      kind: "doctor" as const,
      ownerId: d.id,
      hours: effectiveHours(data.clinicHours, d.working_hours),
      label: d.name,
      color: d.color,
    }));
    // Appointments without a doctor still need a home in the day view.
    if (!doctorFilter && onDay.some((a) => !a.doctor_member_id)) {
      cols.push({ key: "none", day, kind: "doctor", ownerId: null, hours: data.clinicHours, label: "—" });
    }
    return cols;
  }, [data, view, days, anchorDt, visible, byRoom, doctorFilter, tz, locale, t]);

  const fmtLocale = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";
  const title =
    view === "month"
      ? anchorDt.setLocale(fmtLocale).toFormat("LLLL yyyy")
      : view === "week"
        ? `${range.start.setLocale(fmtLocale).toFormat("d LLL")} – ${range.start.plus({ days: 6 }).setLocale(fmtLocale).toFormat("d LLL")}`
        : anchorDt.setLocale(fmtLocale).toFormat("cccc d LLLL");

  /* A drag answers at once; the server confirms or the block goes back. */
  const onApptMoved = async (appt: Appt, s: DateTime, e: DateTime, change: MoveChange) => {
    setData((d) =>
      d && {
        ...d,
        appointments: d.appointments.map((x) =>
          x.id === appt.id
            ? {
                ...x,
                starts_at: s.toUTC().toISO()!,
                ends_at: e.toUTC().toISO()!,
                ...(change.doctorId !== undefined ? { doctor_member_id: change.doctorId } : {}),
                ...(change.roomId !== undefined ? { room_id: change.roomId } : {}),
              }
            : x
        ),
      }
    );
    const r = await updateAppointmentAction(slug, appt.id, {
      startsAt: s.toUTC().toISO()!,
      endsAt: e.toUTC().toISO()!,
      ...(change.doctorId !== undefined ? { doctorMemberId: change.doctorId } : {}),
      ...(change.roomId !== undefined ? { roomId: change.roomId } : {}),
    });
    if (r.error) toast(scheduleErrorText(t, r), "error");
    else toast(savedText(t, t.calendar.updated, r));
    void refetch();
  };

  const viewNames: View[] = ["day", "week", "month", "list"];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => nav(-1)} aria-label={t.common.back}>
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => nav(1)} aria-label={t.common.next}>
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setState({ anchor: DateTime.fromMillis(nowMs).setZone(tz).toISODate()! })}>
            {t.common.today}
          </Button>
        </div>
        <h2 className="min-w-40 font-display text-[15px] font-semibold tnum">{title}</h2>
        {/*
          On a phone the controls are one row that scrolls sideways. Wrapped,
          they stacked four rows deep above a calendar that is sized to the
          screen — every row of filters was a row of appointments nobody saw.
        */}
        <div className="ms-auto flex flex-wrap items-center gap-2 max-sm:w-full max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:[&>*]:shrink-0">
          <div className="flex rounded-full bg-ink-900/5 p-0.5">
            {viewNames.map((v) => (
              <button
                key={v}
                onClick={() => setState({ view: v })}
                aria-pressed={view === v}
                className={`rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${
                  view === v ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"
                }`}
              >
                {v === "list" ? t.calendar.list : t.calendar[v]}
              </button>
            ))}
          </div>
          {view === "day" && hasRooms && (
            <div className="flex rounded-full bg-ink-900/5 p-0.5" aria-label={t.calendar.columns}>
              {(["doctor", "room"] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setState({ groupBy: g })}
                  aria-pressed={groupBy === g}
                  className={`rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${
                    groupBy === g ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"
                  }`}
                >
                  {g === "room" ? t.calendar.byRoom : t.calendar.byDoctor}
                </button>
              ))}
            </div>
          )}
          {!isDoctor && data && data.doctors.length > 0 && (
            <Select value={doctorFilter} onChange={(e) => setState({ doctorFilter: e.target.value })} className="!h-8 !w-auto text-[13px]">
              <option value="">{t.calendar.allDoctors}</option>
              {data.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
          {data && data.sections.length > 0 && (
            <Select
              value={sectionFilter}
              // The service it named may not be in the new section.
              onChange={(e) => setState({ sectionFilter: e.target.value, serviceFilter: "" })}
              className="!h-8 !w-auto text-[13px]"
            >
              <option value="">{t.calendar.allSections}</option>
              {data.sections.map((sec) => (
                <option key={sec.id} value={sec.id}>
                  {locale === "ar" ? sec.name_ar || sec.name : sec.name}
                </option>
              ))}
            </Select>
          )}
          {data && data.services.length > 0 && (
            <Select value={serviceFilter} onChange={(e) => setState({ serviceFilter: e.target.value })} className="!h-8 !w-auto text-[13px]">
              <option value="">{t.calendar.allServices}</option>
              {filterServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {locale === "ar" ? s.name_ar || s.name : s.name}
                </option>
              ))}
            </Select>
          )}
          <button
            onClick={() => setState({ colorBy: colorBy === "service" ? "doctor" : "service" })}
            className="rounded-full border border-line-strong px-3 py-1 text-[12px] font-medium text-ink-500 hover:bg-sunken"
          >
            {t.calendar.colorBy}: {colorBy === "service" ? t.calendar.byService : t.calendar.byDoctor}
          </button>
        </div>
      </div>

      {/* Visits booked before the clinic had rooms hold none — until placed, a
          new booking can land on top of them. */}
      {data && hasRooms && data.unroomed > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-st-pending/30 bg-st-pending-soft px-3 py-2 text-[13px] text-ink-700">
          <DoorOpen className="h-4 w-4 shrink-0 text-st-pending" />
          <span className="min-w-0 flex-1">{t.calendar.unroomed.replace("{n}", String(data.unroomed))}</span>
          {canSetUpRooms && (
            <Link href={`/c/${slug}/settings/rooms`} className="font-semibold text-ink-900 underline underline-offset-2">
              {t.calendar.placeThem}
            </Link>
          )}
        </div>
      )}

      {!data ? (
        <Spinner label={t.common.loading} />
      ) : view === "month" ? (
        <MonthGrid
          days={days}
          anchorDt={anchorDt}
          tz={tz}
          appts={visible}
          colorOf={colorOf}
          blockedDates={data.blockedDates}
          onDayClick={(d) => setState({ anchor: d.toISODate()!, view: "day" })}
        />
      ) : view === "list" ? (
        <AgendaList
          weekStart={range.start}
          anchor={anchorDt}
          tz={tz}
          appts={visible}
          nowMs={nowMs}
          onPickDay={(d) => setState({ anchor: d.toISODate()! })}
          onOpen={onOpen}
          onArrived={onArrived}
          statusLabel={statusLabel}
        />
      ) : (
        <TimeGrid
          columns={columns}
          tz={tz}
          blockedDates={data.blockedDates}
          appts={visible}
          colorOf={colorOf}
          nowMs={nowMs}
          showRoom={hasRooms}
          scrollKey={`${view}:${range.start.toISODate()}`}
          onEmptyClick={(start, col) =>
            onCreate(start, {
              doctorId: col.kind === "doctor" ? col.ownerId ?? null : doctorFilter || null,
              roomId: col.kind === "room" ? col.ownerId ?? null : undefined,
            })
          }
          onApptClick={onOpen}
          onApptMoved={onApptMoved}
          statusLabel={statusLabel}
        />
      )}
    </div>
  );
}
