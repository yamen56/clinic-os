"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { WaitlistEntry } from "@/lib/waitlist";
import { AppointmentPanel, type PanelState } from "./appointment-panel";
import { setFlowAction, type FlowStep } from "./flow-actions";
import { FlowBoard } from "./flow/flow-board";
import { WalkInModal } from "./flow/walk-in-modal";
import { ScheduleView } from "./schedule/schedule-view";
import { WaitlistTab } from "./waitlist/waitlist-tab";
import type { Appt, CalendarData, CalendarMeta, PageCaps, PlannedItem, ScheduleState, ScheduleView as View, Tab } from "./types";
import { Armchair, CalendarDays, Hourglass, Plus, Footprints } from "lucide-react";

/** How often the board's clocks move: waiting times are in whole minutes. */
const TICK_MS = 30_000;

/**
 * Appointments: three views of one diary, on one page.
 *
 *  - Patients today — who is coming, waiting, with the doctor, done, or did
 *    not come; the desk's board and the doctor's.
 *  - Schedule — the calendar.
 *  - Waitlist — who would take an earlier slot.
 *
 * Tabs, not routes: switching is instant and keeps each view's state (the
 * Schedule's date and filters live here), and the booking panel is shared — a
 * waitlist entry's "Book" and a board card's "Book next visit" open the same
 * panel the calendar does. The URL follows the tab (`?tab=`) so a reload or a
 * link lands in the right place.
 */
export function AppointmentsClient({
  slug,
  tz,
  isDoctor,
  selfMemberId,
  initialTab,
  initialView,
  initialPatient,
  initialPlan,
  initialOpen,
  openNew,
  initialWaitlist,
  caps,
  showBoard,
}: {
  slug: string;
  tz: string;
  isDoctor: boolean;
  selfMemberId: string | null;
  initialTab: Tab;
  initialView: View;
  initialPatient: { id: string; name: string } | null;
  initialPlan?: { items: PlannedItem[]; doctorId: string | null; notes: string } | null;
  initialOpen?: { id: string; date: string } | null;
  openNew?: boolean;
  initialWaitlist: number;
  caps: PageCaps;
  /** Off for a workspace whose "appointments" are sales meetings. */
  showBoard: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [schedule, setSchedule] = useState<ScheduleState>(() => ({
    view: initialView,
    anchor: initialOpen?.date ?? DateTime.now().setZone(tz).toISODate()!,
    doctorFilter: isDoctor ? (selfMemberId ?? "") : "",
    serviceFilter: "",
    sectionFilter: "",
    colorBy: "service",
    groupBy: "doctor",
  }));
  const [boardDoctor, setBoardDoctor] = useState(isDoctor ? (selfMemberId ?? "") : "");
  const [today, setToday] = useState<CalendarData | null>(null);
  const [scheduleData, setScheduleData] = useState<CalendarData | null>(null);
  const [panel, setPanel] = useState<PanelState>(
    initialPatient
      ? {
          mode: "create",
          patient: initialPatient,
          items: initialPlan?.items,
          doctorId: initialPlan?.doctorId ?? undefined,
          notes: initialPlan?.notes,
        }
      : openNew
        ? { mode: "create" }
        : null
  );
  const [walkIn, setWalkIn] = useState(false);
  const [version, setVersion] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [waitlistCount, setWaitlistCount] = useState(initialWaitlist);

  /* The board's clock, set from the server's so a fast laptop does not make everyone late. */
  const offset = useRef(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now() + offset.current), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const todayKey = DateTime.fromMillis(nowMs).setZone(tz).toISODate()!;

  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      const url = new URL(window.location.href);
      url.search = next === "today" && showBoard ? "" : `?tab=${next}`;
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {}
  };

  /* Today, always loaded: the board, the tab's counts, and what the panel knows. */
  const refetchToday = useCallback(async () => {
    const start = DateTime.fromISO(todayKey, { zone: tz }).startOf("day");
    const from = start.toUTC().toISO()!;
    const to = start.plus({ days: 1 }).toUTC().toISO()!;
    const res = await fetch(`/api/c/${slug}/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const d = (await res.json()) as CalendarData;
    offset.current = Date.parse(d.serverNow) - Date.now();
    setNowMs(Date.now() + offset.current);
    setToday(d);
  }, [slug, tz, todayKey]);
  useEffect(() => {
    void refetchToday();
  }, [refetchToday]);
  useRealtimeRefresh(slug, ["appointments", "clinic_rooms"], refetchToday);

  const onScheduleData = useCallback((d: CalendarData) => setScheduleData(d), []);
  const meta: CalendarMeta | null = scheduleData ?? today;

  // The visit a link pointed at opens once its day has loaded — once, so closing it stays closed.
  const opened = useRef(false);
  useEffect(() => {
    if (!initialOpen || opened.current) return;
    const appt = (scheduleData?.appointments ?? []).find((x) => x.id === initialOpen.id);
    if (!appt) return;
    opened.current = true;
    setPanel({ mode: "edit", appt });
  }, [scheduleData, initialOpen]);

  const patchToday = (id: string, patch: Partial<Appt>) =>
    setToday((d) => d && { ...d, appointments: d.appointments.map((a) => (a.id === id ? { ...a, ...patch } : a)) });

  /*
    One step of a patient's day. The card moves at once — the press is
    answered by the screen, not by the server — and the server's answer then
    replaces the guess, or puts the card back with the reason.
  */
  const step = async (a: Appt, s: FlowStep, roomId?: string | null) => {
    const now = new Date(nowMs).toISOString();
    const room = roomId !== undefined ? (today?.rooms ?? []).find((r) => r.id === roomId) : null;
    const roomPatch =
      roomId !== undefined ? { room_id: roomId, room_name: room?.name ?? null, room_name_ar: room?.name_ar ?? null, room_color: room?.color ?? null } : {};
    const guess: Partial<Appt> | null =
      s === "arrived"
        ? { arrived_at: now }
        : s === "seated"
          ? { seated_at: now, arrived_at: a.arrived_at ?? now, ...roomPatch }
          : s === "finished"
            ? { status: "completed", finished_at: now, flow_prev_status: a.status }
            : s === "no_show"
              ? { status: "no_show", arrived_at: null, flow_prev_status: a.status }
              : a.flow_prev_status && (a.status === "completed" || a.status === "no_show")
                ? { status: a.flow_prev_status, flow_prev_status: null, finished_at: null }
                : a.seated_at
                  ? { seated_at: null }
                  : { arrived_at: null };
    patchToday(a.id, guess);
    setBusyIds((x) => new Set(x).add(a.id));
    const r = await setFlowAction(slug, a.id, s, roomId !== undefined ? { roomId } : {});
    setBusyIds((x) => {
      const n = new Set(x);
      n.delete(a.id);
      return n;
    });
    if (r.error) {
      toast(
        r.error === "room_occupied"
          ? t.flow.roomOccupied.replace("{name}", r.occupiedBy ?? "")
          : r.error === "not_today"
            ? t.flow.notToday
            : t.flow.stale,
        "error"
      );
      void refetchToday();
      setVersion((v) => v + 1);
      return;
    }
    if (r.row) {
      const rm = (today?.rooms ?? []).find((x) => x.id === r.row!.room_id);
      patchToday(a.id, {
        ...r.row,
        ...(rm ? { room_name: rm.name, room_name_ar: rm.name_ar, room_color: rm.color } : {}),
      });
    }
    if (tab !== "today") setVersion((v) => v + 1);
  };

  const bookFrom = (patient: { id: string; name: string }, opts: { doctorId?: string | null; serviceId?: string | null; start?: string }) =>
    setPanel({
      mode: "create",
      patient,
      doctorId: opts.doctorId ?? undefined,
      serviceId: opts.serviceId ?? undefined,
      start: opts.start,
    });

  const known = useMemo(() => {
    const m = new Map<string, Appt>();
    for (const a of scheduleData?.appointments ?? []) m.set(a.id, a);
    for (const a of today?.appointments ?? []) m.set(a.id, a);
    return [...m.values()];
  }, [scheduleData, today]);

  const waitingCount = useMemo(() => {
    if (!today) return 0;
    return today.appointments.filter(
      (a) =>
        a.arrived_at &&
        !a.seated_at &&
        ["pending_approval", "scheduled", "confirmed"].includes(a.status) &&
        (!isDoctor || !selfMemberId || a.doctor_member_id === selfMemberId)
    ).length;
  }, [today, isDoctor, selfMemberId]);

  const tabs: { key: Tab; label: string; short: string; icon: React.ReactNode; count?: number; tone?: string }[] = [
    ...(showBoard
      ? [{ key: "today" as const, label: t.calendar.tabs.today, short: t.calendar.tabs.todayShort, icon: <Armchair className="h-4 w-4" />, count: waitingCount, tone: "bg-st-waiting text-white" }]
      : []),
    { key: "schedule", label: t.calendar.tabs.schedule, short: t.calendar.tabs.scheduleShort, icon: <CalendarDays className="h-4 w-4" /> },
    { key: "waitlist", label: t.nav.waitlist, short: t.calendar.tabs.waitlistShort, icon: <Hourglass className="h-4 w-4" />, count: waitlistCount },
  ];

  const newAppointment = () => setPanel({ mode: "create", doctorId: isDoctor ? selfMemberId ?? undefined : undefined });

  return (
    <div className={tab === "schedule" ? "flex h-[calc(100dvh_-_14.5rem_-_env(safe-area-inset-top))] min-h-[30rem] flex-col md:h-[calc(100dvh-8.75rem)]" : ""}>
      {/* The page's tabs, and booking — the one action every tab shares. */}
      <div className="mb-4 flex items-end gap-3 border-b border-line">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" data-appointments-tabs>
          {tabs.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => setTab(x.key)}
              className={`relative flex h-11 min-w-0 touch-manipulation items-center justify-center gap-2 whitespace-nowrap px-2.5 text-sm font-semibold max-sm:flex-1 transition-colors duration-140 ease-out sm:px-3.5 ${
                tab === x.key ? "text-ink-900" : "text-ink-500 hover:text-ink-700"
              }`}
            >
              <span className={`max-sm:hidden ${tab === x.key ? "text-ink-900" : "text-ink-400"}`}>{x.icon}</span>
              {/* The full name where there is room for three of them; short on a phone and a tablet. */}
              <span className="hidden lg:inline">{x.label}</span>
              <span className="lg:hidden">{x.short}</span>
              {!!x.count && (
                <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tnum ${x.tone ?? "bg-brand-100 text-brand-700"}`}>
                  {x.count}
                </span>
              )}
              {tab === x.key && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-brand-600" />}
            </button>
          ))}
        </div>
        <div className="mb-1.5 hidden shrink-0 items-center gap-2 sm:flex">
          {showBoard && tab === "today" && (
            <Button variant="outline" size="sm" onClick={() => setWalkIn(true)} aria-label={t.calendar.walkIn} title={t.calendar.walkIn}>
              <Footprints className="h-4 w-4" />
              <span className="max-lg:hidden">{t.calendar.walkIn}</span>
            </Button>
          )}
          <Button size="sm" onClick={newAppointment}>
            <Plus className="h-4 w-4" />
            {t.calendar.newAppointment}
          </Button>
        </div>
      </div>

      {/* On a phone booking is a thumb's reach away, over the bottom bar. */}
      <div className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] end-4 z-30 flex flex-col items-end gap-2 sm:hidden">
        {showBoard && tab === "today" && (
          <button
            type="button"
            onClick={() => setWalkIn(true)}
            className="flex h-11 touch-manipulation items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-ink-900 shadow-pop active:bg-sunken"
          >
            <Footprints className="h-4 w-4" />
            {t.calendar.walkIn}
          </button>
        )}
        <button
          type="button"
          onClick={newAppointment}
          aria-label={t.calendar.newAppointment}
          className="grid h-14 w-14 touch-manipulation place-items-center rounded-full bg-brand-600 text-white shadow-pop active:opacity-85"
        >
          <Plus className="h-6 w-6" />
        </button>
      </div>

      {tab === "today" && showBoard && (
        <div className="pb-20 sm:pb-0">
          <FlowBoard
            slug={slug}
            tz={tz}
            data={today}
            nowMs={nowMs}
            isDoctor={isDoctor}
            selfMemberId={selfMemberId}
            doctorFilter={boardDoctor}
            setDoctorFilter={setBoardDoctor}
            caps={caps}
            busyIds={busyIds}
            onStep={step}
            onOpen={(a) => setPanel({ mode: "edit", appt: a })}
            onBookNext={(a) => bookFrom({ id: a.patient_id, name: a.patient_name }, { doctorId: a.doctor_member_id, serviceId: a.service_id })}
          />
        </div>
      )}

      {tab === "schedule" && (
        <ScheduleView
          slug={slug}
          tz={tz}
          isDoctor={isDoctor}
          state={schedule}
          setState={(patch) => setSchedule((s) => ({ ...s, ...patch }))}
          nowMs={nowMs}
          version={version}
          canSetUpRooms={caps.settingsRooms}
          onData={onScheduleData}
          onOpen={(a) => setPanel({ mode: "edit", appt: a })}
          onCreate={(start, owner) =>
            setPanel({
              mode: "create",
              start: start.toISO()!,
              doctorId: owner.doctorId ?? undefined,
              roomId: owner.roomId ?? undefined,
            })
          }
          onArrived={(a) => void step(a, "arrived")}
        />
      )}

      {tab === "waitlist" && (
        <div className="pb-20 sm:pb-0">
          <WaitlistTab
            slug={slug}
            tz={tz}
            meta={meta}
            onCount={setWaitlistCount}
            onBook={(e: WaitlistEntry, slot) =>
              bookFrom(
                { id: e.patient_id, name: e.full_name },
                { doctorId: slot?.doctorMemberId ?? e.doctor_member_id, serviceId: e.service_id, start: slot?.startISO }
              )
            }
          />
        </div>
      )}

      <AppointmentPanel
        slug={slug}
        tz={tz}
        state={panel}
        onClose={() => setPanel(null)}
        onChanged={() => {
          setPanel(null);
          void refetchToday();
          setVersion((v) => v + 1);
        }}
        doctors={meta?.doctors ?? []}
        services={meta?.services ?? []}
        sections={meta?.sections ?? []}
        rooms={meta?.rooms ?? []}
        known={known}
        nowMs={nowMs}
        canSendDocuments={!isDoctor}
        canOpenPatient={caps.patients}
      />

      <WalkInModal
        slug={slug}
        open={walkIn}
        onClose={() => setWalkIn(false)}
        onDone={() => {
          setWalkIn(false);
          void refetchToday();
        }}
        meta={meta}
        defaultDoctorId={isDoctor ? selfMemberId ?? "" : boardDoctor}
      />
    </div>
  );
}
