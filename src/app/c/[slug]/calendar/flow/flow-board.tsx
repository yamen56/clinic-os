"use client";

import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { flowStage, minutesBetween, LATE_GRACE_MIN, type FlowStage } from "@/lib/patient-flow";
import type { FlowStep } from "../flow-actions";
import type { Appt, CalendarData, PageCaps } from "../types";
import { FlowCard } from "./flow-card";
import { RoomsStrip } from "./rooms-strip";
import { CalendarCheck, ChevronDown, CalendarClock, Armchair, DoorOpen, CheckCheck, UserX, Clock } from "lucide-react";

type Column = "coming" | "waiting" | "in_room" | "finished";
const COLUMNS: Column[] = ["coming", "waiting", "in_room", "finished"];
const columnOf: Partial<Record<FlowStage, Column>> = {
  expected: "coming",
  late: "coming",
  waiting: "waiting",
  in_room: "in_room",
  finished: "finished",
};
/*
  Two by two on a tablet, the urgent pair on top: who is waiting and who is
  with the doctor are what the screen is for, and below a long "Coming" list
  they would be off the bottom of it. Side by side on a desk, in the order a
  patient moves through them.
*/
const tabletOrder: Record<Column, string> = {
  waiting: "md:order-1 xl:order-none",
  in_room: "md:order-2 xl:order-none",
  coming: "md:order-3 xl:order-none",
  finished: "md:order-4 xl:order-none",
};
/*
  Each stage is named and drawn, never colour-coded: a row of coloured dots
  was a legend nobody had been given. Colour is kept for what needs
  somebody's attention — late, a long wait, a visit over its time.
*/
const iconOf: Record<Column, typeof Clock> = {
  coming: CalendarClock,
  waiting: Armchair,
  in_room: DoorOpen,
  finished: CheckCheck,
};

/**
 * Patients today: who is coming, who is sitting in the waiting room, who is
 * with the doctor, who is done, and who did not come.
 *
 * The desk marks someone arrived with one press, and the doctor's screen —
 * this board, and the chime the shell plays on any page — knows at once
 * (realtime, no reload). Reception, doctors and assistants all see the same
 * board; a doctor opens on their own patients.
 *
 * Phone: one column at a time behind a switcher with counts. Tablet: two by
 * two. Desk: all four side by side.
 */
export function FlowBoard({
  slug,
  tz,
  data,
  nowMs,
  isDoctor,
  selfMemberId,
  doctorFilter,
  setDoctorFilter,
  caps,
  busyIds,
  onStep,
  onOpen,
  onBookNext,
}: {
  slug: string;
  tz: string;
  data: CalendarData | null;
  nowMs: number;
  isDoctor: boolean;
  selfMemberId: string | null;
  doctorFilter: string;
  setDoctorFilter: (id: string) => void;
  caps: PageCaps;
  busyIds: Set<string>;
  onStep: (a: Appt, step: FlowStep, roomId?: string | null) => void;
  onOpen: (a: Appt) => void;
  onBookNext: (a: Appt) => void;
}) {
  const { t } = useI18n();
  const [phoneCol, setPhoneCol] = useState<Column | null>(null);
  const [showNoShows, setShowNoShows] = useState(false);

  const today = useMemo(() => {
    if (!data) return [];
    const key = DateTime.fromMillis(nowMs).setZone(tz).toISODate();
    return data.appointments.filter(
      (a) => a.status !== "cancelled" && DateTime.fromISO(a.starts_at).setZone(tz).toISODate() === key
    );
  }, [data, nowMs, tz]);

  const mine = useMemo(
    () => (doctorFilter ? today.filter((a) => a.doctor_member_id === doctorFilter) : today),
    [today, doctorFilter]
  );

  const staged = useMemo(
    () =>
      mine.map((a) => ({
        a,
        stage: flowStage(
          { status: a.status, starts_at: a.starts_at, arrived_at: a.arrived_at ?? null, seated_at: a.seated_at ?? null },
          nowMs
        ),
      })),
    [mine, nowMs]
  );

  const cols = useMemo(() => {
    const m: Record<Column, { a: Appt; stage: FlowStage }[]> = { coming: [], waiting: [], in_room: [], finished: [] };
    for (const x of staged) {
      const c = columnOf[x.stage];
      if (c) m[c].push(x);
    }
    m.coming.sort((p, q) => p.a.starts_at.localeCompare(q.a.starts_at));
    m.waiting.sort((p, q) => (p.a.arrived_at ?? "").localeCompare(q.a.arrived_at ?? ""));
    m.in_room.sort((p, q) => (p.a.seated_at ?? "").localeCompare(q.a.seated_at ?? ""));
    m.finished.sort((p, q) => (q.a.finished_at ?? q.a.ends_at).localeCompare(p.a.finished_at ?? p.a.ends_at));
    return m;
  }, [staged]);
  const noShows = staged.filter((x) => x.stage === "no_show");
  const late = cols.coming.filter((x) => x.stage === "late").length;
  const avgWait = cols.waiting.length
    ? Math.round(cols.waiting.reduce((n, x) => n + minutesBetween(x.a.arrived_at!, nowMs), 0) / cols.waiting.length)
    : 0;

  /* Who is in each room right now, from the whole clinic's day — a room is
     taken whichever doctor's patient is in it. */
  const occupants = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const a of today) {
      if (a.room_id && a.seated_at && !a.finished_at && ["pending_approval", "scheduled", "confirmed"].includes(a.status)) {
        m.set(a.room_id, { id: a.id, name: a.patient_name });
      }
    }
    return m;
  }, [today]);

  if (!data) return <Spinner label={t.common.loading} />;

  const activeCol: Column = phoneCol ?? (cols.waiting.length ? "waiting" : cols.in_room.length && !cols.coming.length ? "in_room" : "coming");
  const doctors = data.doctors;
  const rooms = data.rooms;

  const chip = (on: boolean) =>
    `inline-flex h-8 shrink-0 touch-manipulation items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors ${
      on ? "border-brand-600 bg-brand-600 text-white" : "border-line-strong bg-surface text-ink-700 hover:bg-sunken"
    }`;

  return (
    <div className="grid grid-cols-1 gap-4" data-flow-board>
      {/* Whose patients: a doctor starts on their own. */}
      {doctors.length > 1 || (isDoctor && selfMemberId) ? (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {isDoctor && selfMemberId && (
            <button type="button" aria-pressed={doctorFilter === selfMemberId} className={chip(doctorFilter === selfMemberId)} onClick={() => setDoctorFilter(selfMemberId)}>
              {t.calendar.mine}
            </button>
          )}
          <button type="button" aria-pressed={!doctorFilter} className={chip(!doctorFilter)} onClick={() => setDoctorFilter("")}>
            {t.calendar.everyone}
          </button>
          {!isDoctor &&
            doctors.map((d) => (
              <button key={d.id} type="button" aria-pressed={doctorFilter === d.id} className={chip(doctorFilter === d.id)} onClick={() => setDoctorFilter(d.id)}>
                {d.name}
              </button>
            ))}
        </div>
      ) : null}

      {/* The day in six numbers. */}
      <div className="grid grid-cols-3 gap-2 lg:grid-cols-6" data-flow-summary>
        <Stat label={t.flow.expected} value={cols.coming.length} icon={CalendarClock} />
        <Stat
          label={t.flow.waitingNow}
          value={cols.waiting.length}
          icon={Armchair}
          sub={cols.waiting.length ? t.flow.avgWait.replace("{n}", String(avgWait)) : undefined}
        />
        <Stat
          label={t.flow.inRooms}
          value={rooms.length ? `${occupants.size}/${rooms.length}` : cols.in_room.length}
          icon={DoorOpen}
        />
        <Stat label={t.flow.finished} value={cols.finished.length} icon={CheckCheck} />
        <Stat label={t.flow.didntCome} value={noShows.length} icon={UserX} />
        <Stat label={t.flow.late} value={late} icon={Clock} alert={late > 0} title={t.flow.lateNote.replace("{n}", String(LATE_GRACE_MIN))} />
      </div>

      <RoomsStrip slug={slug} rooms={rooms} appts={today} nowMs={nowMs} tz={tz} canSetUp={caps.settingsRooms} />

      {mine.length === 0 ? (
        <EmptyState icon={<CalendarCheck />} title={t.flow.emptyToday} body={t.flow.emptyTodayBody} />
      ) : (
        <>
          {/* Phone: one column at a time. */}
          <div className="grid grid-cols-4 gap-1 rounded-full bg-ink-900/5 p-1 md:hidden" role="tablist">
            {COLUMNS.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={activeCol === c}
                onClick={() => setPhoneCol(c)}
                className={`flex min-w-0 touch-manipulation flex-col items-center rounded-full px-1 py-1 text-[11px] font-medium leading-tight transition-colors ${
                  activeCol === c ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"
                }`}
              >
                <span className="text-[15px] font-bold tnum">
                  {cols[c].length}
                </span>
                <span className="max-w-full truncate">{t.flow.columnsShort[c]}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" data-flow-columns>
            {COLUMNS.map((c) => (
              <section
                key={c}
                data-flow-column={c}
                className={`min-w-0 flex-col rounded-card bg-sunken/70 p-2 ${tabletOrder[c]} ${activeCol === c ? "flex" : "max-md:hidden md:flex"}`}
              >
                <header className="flex items-center gap-2 px-1.5 pb-2 pt-1">
                  {(() => {
                    const Icon = iconOf[c];
                    return <Icon className="h-4 w-4 shrink-0 text-ink-500" strokeWidth={1.75} aria-hidden />;
                  })()}
                  <h3 className="font-display text-[13.5px] font-semibold text-ink-900">{t.flow.columns[c]}</h3>
                  <span className="ms-auto rounded-full bg-surface px-2 text-[12px] font-semibold text-ink-500 tnum shadow-card">
                    {cols[c].length}
                  </span>
                </header>
                <div className="grid gap-2">
                  {cols[c].length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-[12.5px] text-ink-400">
                      {t.flow.emptyColumn}
                    </div>
                  ) : (
                    cols[c].map(({ a, stage }) => (
                      <FlowCard
                        key={a.id}
                        slug={slug}
                        appt={a}
                        stage={stage}
                        nowMs={nowMs}
                        tz={tz}
                        rooms={rooms}
                        occupants={occupants}
                        caps={caps}
                        currency={data?.currency ?? ""}
                        busy={busyIds.has(a.id)}
                        onStep={(step, roomId) => onStep(a, step, roomId)}
                        onOpen={() => onOpen(a)}
                        onBookNext={() => onBookNext(a)}
                      />
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>

          {noShows.length > 0 && (
            <section className="rounded-card border border-line bg-surface" data-flow-column="no_show">
              <button
                type="button"
                onClick={() => setShowNoShows((v) => !v)}
                aria-expanded={showNoShows}
                className="flex w-full items-center gap-2 px-4 py-3 text-start"
              >
                <UserX className="h-4 w-4 shrink-0 text-ink-500" strokeWidth={1.75} aria-hidden />
                <span className="font-display text-[13.5px] font-semibold text-ink-900">{t.flow.columns.no_show}</span>
                <span className="rounded-full bg-sunken px-2 text-[12px] font-semibold text-ink-500 tnum">{noShows.length}</span>
                <ChevronDown className={`ms-auto h-4 w-4 text-ink-400 transition-transform ${showNoShows ? "rotate-180" : ""}`} />
              </button>
              {showNoShows && (
                <div className="grid gap-2 border-t border-line p-2 sm:grid-cols-2 xl:grid-cols-4">
                  {noShows.map(({ a, stage }) => (
                    <FlowCard
                      key={a.id}
                      slug={slug}
                      appt={a}
                      stage={stage}
                      nowMs={nowMs}
                      tz={tz}
                      rooms={rooms}
                      occupants={occupants}
                      caps={caps}
                      currency={data?.currency ?? ""}
                      busy={busyIds.has(a.id)}
                      onStep={(step, roomId) => onStep(a, step, roomId)}
                      onOpen={() => onOpen(a)}
                      onBookNext={() => onBookNext(a)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/*
  A figure, its name, and an icon that says the same — in ink, not a colour
  to decode. Only Late turns orange, and only when somebody is.
*/
function Stat({
  label,
  value,
  icon: Icon,
  sub,
  alert,
  title,
}: {
  label: string;
  value: number | string;
  icon: typeof Clock;
  sub?: string;
  alert?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      data-stat-alert={alert ? "1" : undefined}
      className={`flex min-w-0 items-center gap-2.5 rounded-card border px-2.5 py-2 shadow-card sm:px-3 sm:py-2.5 ${
        alert ? "border-st-late/40 bg-st-late-soft" : "border-line bg-surface"
      }`}
    >
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg max-sm:hidden ${
          alert ? "bg-surface text-st-late" : "bg-sunken text-ink-500"
        }`}
      >
        <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </span>
      <div className="min-w-0">
        <div className={`truncate text-[11.5px] font-medium ${alert ? "text-st-late" : "text-ink-500"}`}>{label}</div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="font-display text-[18px] font-bold leading-none text-ink-900 tnum sm:text-[20px]">{value}</span>
          {sub && <span className="truncate text-[11px] text-ink-400 tnum">{sub}</span>}
        </div>
      </div>
    </div>
  );
}
