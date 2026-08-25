"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { useRealtime } from "@/lib/use-realtime";
import { rangesForDay, hmToMin, effectiveHours, type WeeklyHours } from "@/lib/hours";
import type { IntakeAnswer } from "@/lib/booking-intake";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { AppointmentPanel, type PanelState } from "./appointment-panel";
import { updateAppointmentAction } from "./actions";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { inkOn } from "@/lib/contrast";

export type Appt = {
  id: string;
  patient_id: string;
  doctor_member_id: string | null;
  service_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  notes: string;
  /** Answers to the clinic's booking questions, frozen at booking time. */
  intake_answers: IntakeAnswer[];
  patient_name: string;
  patient_phone: string | null;
  service_name: string | null;
  service_name_ar: string | null;
  service_color: string | null;
  doctor_color: string | null;
  doctor_name: string | null;
};

export type Doctor = {
  id: string;
  name: string;
  color: string;
  title: string | null;
  specialty: string | null;
  working_hours: WeeklyHours | null;
};

export type Service = {
  id: string;
  name: string;
  name_ar: string | null;
  duration_min: number;
  price: string;
  color: string;
  buffer_after_min: number;
};

const START_MIN = 7 * 60;
const END_MIN = 22 * 60;
const PX = 1.5; // pixels per minute
const SNAP = 15;

const statusStyle: Record<string, string> = {
  pending_approval: "border-dashed",
  scheduled: "",
  confirmed: "",
  completed: "opacity-70",
  no_show: "opacity-45 line-through",
  cancelled: "hidden",
};

export function CalendarClient({
  slug,
  tz,
  isDoctor,
  selfMemberId,
  initialPatient,
}: {
  slug: string;
  tz: string;
  isDoctor: boolean;
  selfMemberId: string | null;
  initialPatient: { id: string; name: string } | null;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [view, setView] = useState<"day" | "week" | "month">("week");
  const [anchor, setAnchor] = useState(() => DateTime.now().setZone(tz).toISODate()!);
  const [doctorFilter, setDoctorFilter] = useState<string>(isDoctor ? (selfMemberId ?? "") : "");
  const [serviceFilter, setServiceFilter] = useState("");
  const [colorBy, setColorBy] = useState<"service" | "doctor">("service");
  const [data, setData] = useState<{
    appointments: Appt[];
    doctors: Doctor[];
    services: Service[];
    clinicHours: WeeklyHours;
    blockedDates: string[];
  } | null>(null);
  const [panel, setPanel] = useState<PanelState>(
    initialPatient ? { mode: "create", patient: initialPatient } : null
  );

  const anchorDt = useMemo(() => DateTime.fromISO(anchor, { zone: tz }), [anchor, tz]);

  const range = useMemo(() => {
    if (view === "day") return { start: anchorDt.startOf("day"), days: 1 };
    if (view === "week") {
      // Week starts Sunday (Jordan work week)
      const start = anchorDt.startOf("day").minus({ days: anchorDt.weekday % 7 });
      return { start, days: 7 };
    }
    const first = anchorDt.startOf("month");
    const start = first.minus({ days: first.weekday % 7 });
    return { start, days: 42 };
  }, [anchorDt, view]);

  const refetch = useCallback(async () => {
    const from = range.start.toUTC().toISO();
    const to = range.start.plus({ days: range.days }).toUTC().toISO();
    const res = await fetch(`/api/c/${slug}/appointments?from=${from}&to=${to}`);
    if (res.ok) setData(await res.json());
  }, [slug, range]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useRealtime(slug, ["appointments"], () => void refetch());

  const days = useMemo(
    () => Array.from({ length: view === "month" ? 42 : range.days }, (_, i) => range.start.plus({ days: i })),
    [range, view]
  );

  const filteredAppts = useMemo(() => {
    if (!data) return [];
    return data.appointments.filter(
      (a) =>
        (!doctorFilter || a.doctor_member_id === doctorFilter) &&
        (!serviceFilter || a.service_id === serviceFilter)
    );
  }, [data, doctorFilter, serviceFilter]);

  const colorOf = (a: Appt) =>
    colorBy === "doctor"
      ? a.doctor_color ?? "var(--color-ink-400)"
      : a.service_color ?? "var(--color-brand-600)";

  const nav = (dir: -1 | 1) => {
    const unit = view === "day" ? { days: 1 } : view === "week" ? { weeks: 1 } : { months: 1 };
    setAnchor(dir === 1 ? anchorDt.plus(unit).toISODate()! : anchorDt.minus(unit).toISODate()!);
  };

  // Day view shows doctors side by side (unless filtered)
  const dayColumns: { key: string; label: string; doctorId: string | null; hours: WeeklyHours }[] =
    useMemo(() => {
      if (!data) return [];
      const docs = doctorFilter ? data.doctors.filter((d) => d.id === doctorFilter) : data.doctors;
      if (view !== "day" || docs.length === 0) {
        return [{ key: "all", label: "", doctorId: doctorFilter || null, hours: data.clinicHours }];
      }
      const cols = docs.map((d) => ({
        key: d.id,
        label: d.name,
        doctorId: d.id as string | null,
        hours: effectiveHours(data.clinicHours, d.working_hours),
      }));
      // Appointments without a doctor still need a home in day view
      const hasUnassigned = data.appointments.some(
        (a) => !a.doctor_member_id && a.status !== "cancelled"
      );
      if (hasUnassigned && !doctorFilter) {
        cols.push({ key: "none", label: "—", doctorId: null, hours: data.clinicHours });
      }
      return cols;
    }, [data, view, doctorFilter]);

  const fmtLocale = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";
  const title =
    view === "month"
      ? anchorDt.setLocale(fmtLocale).toFormat("LLLL yyyy")
      : view === "week"
        ? `${range.start.setLocale(fmtLocale).toFormat("d LLL")} – ${range.start
            .plus({ days: 6 })
            .setLocale(fmtLocale)
            .toFormat("d LLL")}`
        : anchorDt.setLocale(fmtLocale).toFormat("cccc d LLLL");

  const openCreate = (start: DateTime, doctorId: string | null) =>
    setPanel({ mode: "create", start: start.toISO()!, doctorId: doctorId ?? undefined });

  const onApptMoved = async (
    appt: Appt,
    newStart: DateTime,
    newEnd: DateTime,
    newDoctor: string | null | undefined
  ) => {
    const r = await updateAppointmentAction(slug, appt.id, {
      startsAt: newStart.toUTC().toISO()!,
      endsAt: newEnd.toUTC().toISO()!,
      ...(newDoctor !== undefined ? { doctorMemberId: newDoctor } : {}),
    });
    if (r.error === "conflict") {
      toast(`${t.calendar.conflict}${r.conflictWith ? ` (${r.conflictWith})` : ""}`, "error");
    } else if (r.error) {
      toast(t.common.genericError, "error");
    } else {
      toast(t.calendar.updated);
    }
    void refetch();
  };

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] flex-col md:h-[calc(100dvh-5.5rem)]">
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => nav(-1)} aria-label={t.common.back}>
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => nav(1)} aria-label={t.common.next}>
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAnchor(DateTime.now().setZone(tz).toISODate()!)}>
            {t.common.today}
          </Button>
        </div>
        <h2 className="min-w-40 text-[15px] font-semibold tnum">{title}</h2>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-full bg-ink-900/5 p-0.5">
            {(["day", "week", "month"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${
                  view === v ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"
                }`}
              >
                {t.calendar[v]}
              </button>
            ))}
          </div>
          {!isDoctor && data && data.doctors.length > 0 && (
            <Select value={doctorFilter} onChange={(e) => setDoctorFilter(e.target.value)} className="!h-8 !w-auto text-[13px]">
              <option value="">{t.calendar.allDoctors}</option>
              {data.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
          {data && data.services.length > 0 && (
            <Select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} className="!h-8 !w-auto text-[13px]">
              <option value="">{t.calendar.allServices}</option>
              {data.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {locale === "ar" ? s.name_ar || s.name : s.name}
                </option>
              ))}
            </Select>
          )}
          <button
            onClick={() => setColorBy(colorBy === "service" ? "doctor" : "service")}
            className="rounded-full border border-line-strong px-3 py-1 text-[12px] font-medium text-ink-500 hover:bg-sunken"
          >
            {t.calendar.colorBy}: {colorBy === "service" ? t.calendar.byService : t.calendar.byDoctor}
          </button>
          <Button size="sm" onClick={() => openCreate(anchorDt.set({ hour: 10 }), doctorFilter || null)}>
            <Plus className="h-4 w-4" />
            {t.calendar.newAppointment}
          </Button>
        </div>
      </div>

      {!data ? (
        <Spinner label={t.common.loading} />
      ) : view === "month" ? (
        <MonthGrid
          days={days}
          anchorDt={anchorDt}
          tz={tz}
          appts={filteredAppts}
          colorOf={colorOf}
          onDayClick={(d) => {
            setAnchor(d.toISODate()!);
            setView("day");
          }}
        />
      ) : (
        <TimeGrid
          days={view === "day" ? [anchorDt.startOf("day")] : days}
          dayColumns={view === "day" ? dayColumns : null}
          tz={tz}
          locale={locale}
          clinicHours={data.clinicHours}
          blockedDates={data.blockedDates}
          doctors={data.doctors}
          appts={filteredAppts}
          colorOf={colorOf}
          onEmptyClick={openCreate}
          onApptClick={(a) => setPanel({ mode: "edit", appt: a })}
          onApptMoved={onApptMoved}
          statusLabel={(s) => (t.calendar.statuses as Record<string, string>)[s] ?? s}
        />
      )}

      <AppointmentPanel
        slug={slug}
        tz={tz}
        state={panel}
        onClose={() => setPanel(null)}
        onChanged={() => {
          setPanel(null);
          void refetch();
        }}
        doctors={data?.doctors ?? []}
        services={data?.services ?? []}
        canSendDocuments={!isDoctor}
      />
    </div>
  );
}

/* ---------------- Month ---------------- */

function MonthGrid({
  days,
  anchorDt,
  tz,
  appts,
  colorOf,
  onDayClick,
}: {
  days: DateTime[];
  anchorDt: DateTime;
  tz: string;
  appts: Appt[];
  colorOf: (a: Appt) => string;
  onDayClick: (d: DateTime) => void;
}) {
  const { t, locale } = useI18n();
  const byDay = useMemo(() => {
    const m = new Map<string, Appt[]>();
    for (const a of appts) {
      if (a.status === "cancelled") continue;
      const k = DateTime.fromISO(a.starts_at).setZone(tz).toISODate()!;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    return m;
  }, [appts, tz]);
  const today = DateTime.now().setZone(tz).toISODate();

  return (
    <div className="flex-1 overflow-auto rounded-card border border-line bg-surface shadow-card">
      <div className="grid min-w-[640px] grid-cols-7 border-b border-line text-center text-[12px] font-medium text-ink-500">
        {days.slice(0, 7).map((d) => (
          <div key={d.toISO()} className="py-2">
            {d.setLocale(locale === "ar" ? "ar" : "en-GB").toFormat("ccc")}
          </div>
        ))}
      </div>
      <div className="grid min-w-[640px] grid-cols-7">
        {days.map((d) => {
          const k = d.toISODate()!;
          const list = byDay.get(k) ?? [];
          const inMonth = d.month === anchorDt.month;
          return (
            <button
              key={k}
              onClick={() => onDayClick(d)}
              className={`min-h-24 border-b border-e border-line p-1.5 text-start align-top transition-colors hover:bg-brand-50/40 ${
                inMonth ? "" : "bg-subtle text-ink-300"
              }`}
            >
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold tnum ${
                  k === today ? "bg-brand-600 text-white" : ""
                }`}
              >
                {d.day}
              </span>
              <div className="mt-0.5 grid gap-0.5">
                {list.slice(0, 3).map((a) => (
                  <span
                    key={a.id}
                    className="truncate rounded px-1 py-0.5 text-[11px] font-medium"
                    style={{ background: colorOf(a), color: inkOn(colorOf(a)) }}
                  >
                    {a.patient_name}
                  </span>
                ))}
                {list.length > 3 && (
                  <span className="text-[11px] text-ink-400 tnum">+{list.length - 3}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Day / Week time grid ---------------- */

function TimeGrid({
  days,
  dayColumns,
  tz,
  locale,
  clinicHours,
  blockedDates,
  doctors,
  appts,
  colorOf,
  onEmptyClick,
  onApptClick,
  onApptMoved,
  statusLabel,
}: {
  days: DateTime[];
  dayColumns: { key: string; label: string; doctorId: string | null; hours: WeeklyHours }[] | null;
  tz: string;
  locale: string;
  clinicHours: WeeklyHours;
  blockedDates: string[];
  doctors: Doctor[];
  appts: Appt[];
  colorOf: (a: Appt) => string;
  onEmptyClick: (start: DateTime, doctorId: string | null) => void;
  onApptClick: (a: Appt) => void;
  onApptMoved: (a: Appt, s: DateTime, e: DateTime, doctor: string | null | undefined) => void;
  statusLabel: (s: string) => string;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const totalH = (END_MIN - START_MIN) * PX;
  const now = DateTime.now().setZone(tz);
  const isDayView = !!dayColumns && days.length === 1;

  const columns: { day: DateTime; doctorId: string | null; hours: WeeklyHours; label: string }[] =
    isDayView
      ? dayColumns!.map((c) => ({ day: days[0], doctorId: c.doctorId, hours: c.hours, label: c.label }))
      : days.map((d) => ({ day: d, doctorId: null, hours: clinicHours, label: "" }));

  // drag state
  const drag = useRef<{
    appt: Appt;
    mode: "move" | "resize";
    startY: number;
    startX: number;
    colIndex: number;
    origStart: DateTime;
    origEnd: DateTime;
    moved: boolean;
  } | null>(null);
  type Preview = { apptId: string; start: DateTime; end: DateTime; colIndex: number };
  const [dragPreview, setDragPreview] = useState<Preview | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const setPreview = (p: Preview | null) => {
    previewRef.current = p;
    setDragPreview(p);
  };

  const colWidth = () => {
    const el = gridRef.current;
    if (!el) return 1;
    return el.scrollWidth / columns.length;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dy = e.clientY - d.startY;
      const dx = e.clientX - d.startX;
      if (Math.abs(dy) > 4 || Math.abs(dx) > 8) d.moved = true;
      if (!d.moved) return;
      const dMin = Math.round(dy / PX / SNAP) * SNAP;
      const rtl = document.documentElement.dir === "rtl";
      const dCol = Math.round((rtl ? -dx : dx) / colWidth());
      const colIndex = Math.min(Math.max(d.colIndex + dCol, 0), columns.length - 1);
      if (d.mode === "move") {
        const dur = d.origEnd.diff(d.origStart, "minutes").minutes;
        let start = d.origStart.plus({ minutes: dMin });
        // moving across columns changes day (week view) — keep time-of-day
        if (!isDayView && colIndex !== d.colIndex) {
          start = columns[colIndex].day.set({ hour: start.hour, minute: start.minute });
        }
        setPreview({ apptId: d.appt.id, start, end: start.plus({ minutes: dur }), colIndex });
      } else {
        const end = d.origEnd.plus({ minutes: dMin });
        if (end.diff(d.origStart, "minutes").minutes >= SNAP) {
          setPreview({ apptId: d.appt.id, start: d.origStart, end, colIndex: d.colIndex });
        }
      }
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const prev = previewRef.current;
      setPreview(null);
      if (d.moved && prev) {
        const newDoctor = isDayView ? columns[prev.colIndex].doctorId : undefined;
        onApptMoved(d.appt, prev.start, prev.end, newDoctor);
      } else if (!d.moved) {
        onApptClick(d.appt);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, isDayView]);

  const apptsFor = (col: { day: DateTime; doctorId: string | null }) =>
    appts.filter((a) => {
      if (a.status === "cancelled") return false;
      const s = DateTime.fromISO(a.starts_at).setZone(tz);
      if (s.toISODate() !== col.day.toISODate()) return false;
      if (isDayView && col.doctorId && a.doctor_member_id !== col.doctorId) return false;
      if (isDayView && !col.doctorId && dayColumns!.length > 1 && a.doctor_member_id) return false;
      return true;
    });

  return (
    <div className="flex-1 overflow-auto rounded-card border border-line bg-surface shadow-card">
      <div className="flex min-w-fit">
        {/* time gutter */}
        <div className="sticky start-0 z-10 w-14 shrink-0 border-e border-line bg-surface">
          <div className="h-9 border-b border-line" />
          <div className="relative" style={{ height: totalH }}>
            {Array.from({ length: (END_MIN - START_MIN) / 60 }, (_, i) => (
              <span
                key={i}
                className="absolute inline-block w-full pe-1.5 text-end text-[11px] text-ink-400 tnum"
                style={{ top: i * 60 * PX - 7 }}
              >
                {DateTime.fromObject({ hour: (START_MIN / 60) + i }).setLocale("en-GB").toFormat("h a")}
              </span>
            ))}
          </div>
        </div>

        <div ref={gridRef} className="flex flex-1">
          {columns.map((col, ci) => {
            const isToday = col.day.toISODate() === now.toISODate();
            const blocked = blockedDates.includes(col.day.toISODate()!);
            const ranges = rangesForDay(col.hours, col.day);
            const colAppts = apptsFor(col);
            return (
              <div key={ci} className="min-w-32 flex-1 border-e border-line last:border-e-0">
                {/* header */}
                <div
                  className={`sticky top-0 z-10 flex h-9 items-center justify-center gap-1.5 border-b border-line bg-surface px-1 text-[12px] font-medium ${
                    isToday ? "text-brand-700" : "text-ink-500"
                  }`}
                >
                  {isDayView ? (
                    <>
                      {col.label && (
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: doctors.find((d) => d.id === col.doctorId)?.color }}
                        />
                      )}
                      {col.label || col.day.setLocale(locale === "ar" ? "ar" : "en-GB").toFormat("cccc d")}
                    </>
                  ) : (
                    <>
                      {col.day.setLocale(locale === "ar" ? "ar" : "en-GB").toFormat("ccc")}
                      <span className={`tnum ${isToday ? "flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white" : ""}`}>
                        {col.day.day}
                      </span>
                    </>
                  )}
                </div>
                {/* body */}
                <div
                  className={`relative ${blocked ? "bg-danger-soft/40" : ""}`}
                  style={{ height: totalH }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("[data-appt]")) return;
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const min = START_MIN + Math.floor((e.clientY - rect.top) / PX / 30) * 30;
                    onEmptyClick(col.day.plus({ minutes: min }), col.doctorId);
                  }}
                >
                  {/* non-working shading */}
                  {ranges.length === 0 ? (
                    <div className="absolute inset-0 bg-ink-900/4" />
                  ) : (
                    <>
                      <div
                        className="absolute inset-x-0 top-0 bg-ink-900/4"
                        style={{ height: Math.max(0, (hmToMin(ranges[0][0]) - START_MIN) * PX) }}
                      />
                      <div
                        className="absolute inset-x-0 bottom-0 bg-ink-900/4"
                        style={{
                          height: Math.max(0, (END_MIN - hmToMin(ranges[ranges.length - 1][1])) * PX),
                        }}
                      />
                    </>
                  )}
                  {/* hour lines */}
                  {Array.from({ length: (END_MIN - START_MIN) / 60 }, (_, i) => (
                    <div
                      key={i}
                      className="pointer-events-none absolute inset-x-0 border-t border-line/70"
                      style={{ top: i * 60 * PX }}
                    />
                  ))}
                  {/* current time line */}
                  {isToday && now.hour * 60 + now.minute > START_MIN && now.hour * 60 + now.minute < END_MIN && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger"
                      style={{ top: (now.hour * 60 + now.minute - START_MIN) * PX }}
                    >
                      <span className="absolute -top-1 start-0 h-2 w-2 rounded-full bg-danger" />
                    </div>
                  )}
                  {/* appointments */}
                  {colAppts.map((a) => {
                    const isPreview = dragPreview?.apptId === a.id;
                    const s = isPreview ? dragPreview!.start : DateTime.fromISO(a.starts_at).setZone(tz);
                    const e2 = isPreview ? dragPreview!.end : DateTime.fromISO(a.ends_at).setZone(tz);
                    if (isPreview && dragPreview!.colIndex !== ci && !isDayView) return null;
                    const top = (s.hour * 60 + s.minute - START_MIN) * PX;
                    const h = Math.max(e2.diff(s, "minutes").minutes * PX, 20);
                    return (
                      <div
                        key={a.id}
                        data-appt
                        onPointerDown={(ev) => {
                          if ((ev.target as HTMLElement).dataset.resize) return;
                          ev.preventDefault();
                          drag.current = {
                            appt: a,
                            mode: "move",
                            startY: ev.clientY,
                            startX: ev.clientX,
                            colIndex: ci,
                            origStart: DateTime.fromISO(a.starts_at).setZone(tz),
                            origEnd: DateTime.fromISO(a.ends_at).setZone(tz),
                            moved: false,
                          };
                        }}
                        className={`absolute inset-x-0.5 z-[5] cursor-grab touch-none select-none overflow-hidden rounded-md border border-black/5 px-1.5 py-0.5 shadow-sm transition-shadow hover:shadow-md ${statusStyle[a.status] ?? ""} ${isPreview ? "z-20 opacity-80 ring-2 ring-brand-400" : ""}`}
                        style={{ top, height: h, background: colorOf(a), color: inkOn(colorOf(a)) }}
                        title={`${a.patient_name} · ${statusLabel(a.status)}`}
                      >
                        <div className="truncate text-[11px] font-semibold leading-tight">
                          {s.toFormat("h:mm")} {a.patient_name}
                        </div>
                        {h > 34 && (
                          <div className="truncate text-[10px] leading-tight opacity-85">
                            {(locale === "ar" ? a.service_name_ar : null) || a.service_name || ""}
                          </div>
                        )}
                        {h > 50 && a.doctor_name && !isDayView && (
                          <div className="truncate text-[10px] leading-tight opacity-70">{a.doctor_name}</div>
                        )}
                        <div
                          data-resize="1"
                          onPointerDown={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            drag.current = {
                              appt: a,
                              mode: "resize",
                              startY: ev.clientY,
                              startX: ev.clientX,
                              colIndex: ci,
                              origStart: DateTime.fromISO(a.starts_at).setZone(tz),
                              origEnd: DateTime.fromISO(a.ends_at).setZone(tz),
                              moved: false,
                            };
                          }}
                          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                        />
                      </div>
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
