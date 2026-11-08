"use client";

/*
  Today's patients on the dashboard — each one a way in, not a line to read.

  The row opens the patient's file (or the visit, for somebody who may not
  open files), and the one next step for where they are today sits at its
  end: Arrived, Call in, Finish — the same step the board's card offers, by
  the same action.

  Everybody sees the same day — the desk, every doctor, the owner — with a
  count of who is in the waiting room, with a doctor, still to come and done
  across the top. Each count is also a filter. A doctor's own patients say
  "You" where the others name their doctor.

  Held here, not re-read after the press: the step shows the moment it is
  pressed, and the realtime stream brings the page up to date behind it, the
  same as it does when somebody else moves a patient on the board.
*/

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Armchair, CheckCheck, DoorOpen } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { fmtTime } from "@/lib/dates";
import { flowStage, type FlowStage } from "@/lib/patient-flow";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { setFlowAction, type FlowStep, type Handoff } from "./calendar/flow-actions";
import { FinishVisitSheet } from "@/components/appointments/finish-visit-sheet";

export type TodayRow = {
  id: string;
  patient_id: string;
  starts_at: string;
  status: string;
  arrived_at: string | null;
  seated_at: string | null;
  patient_name: string;
  service_name: string | null;
  service_name_ar: string | null;
  service_color: string | null;
  doctor_member_id: string | null;
  doctor_name: string | null;
};

/** The groups across the top, each a count and a filter. Late patients are still to come. */
type Group = "all" | "waiting" | "in_room" | "coming" | "done";
const groupOf = (s: FlowStage): Group => (s === "waiting" ? "waiting" : s === "in_room" ? "in_room" : s === "expected" || s === "late" ? "coming" : "done");

const apptStatus: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

/** The one step that moves a patient on from each stage, as the board offers it. */
const NEXT: Partial<Record<FlowStage, FlowStep>> = { expected: "arrived", late: "arrived", waiting: "seated", in_room: "finished" };

export function TodayList({
  slug,
  tz,
  rows,
  canFlow,
  canOpenPatient,
  selfMemberId,
}: {
  slug: string;
  tz: string;
  rows: TodayRow[];
  /** May move a patient through the clinic — the calendar capability. */
  canFlow: boolean;
  canOpenPatient: boolean;
  /** The viewer's membership, so their own patients read "You". */
  selfMemberId: string | null;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [moved, setMoved] = useState<Record<string, Partial<TodayRow>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [group, setGroup] = useState<Group>("all");
  useRealtimeRefresh(slug, ["appointments"], () => {
    setMoved({});
    router.refresh();
  });

  const [finishing, setFinishing] = useState<TodayRow | null>(null);
  const step = async (row: TodayRow, s: FlowStep, handoff?: Handoff | null) => {
    const now = new Date().toISOString();
    const guess: Partial<TodayRow> =
      s === "arrived" ? { arrived_at: now } : s === "seated" ? { seated_at: now, arrived_at: row.arrived_at ?? now } : { status: "completed" };
    setMoved((m) => ({ ...m, [row.id]: guess }));
    setBusy(row.id);
    const r = await setFlowAction(slug, row.id, s, handoff ? { handoff } : {});
    setBusy(null);
    setFinishing(null);
    if (r.error) {
      setMoved((m) => {
        const { [row.id]: _, ...rest } = m;
        return rest;
      });
      toast(
        r.error === "room_occupied" ? t.flow.roomOccupied.replace("{name}", r.occupiedBy ?? "") : r.error === "not_today" ? t.flow.notToday : t.flow.stale,
        "error"
      );
    }
  };

  const label: Record<FlowStep, string> = { arrived: t.flow.arrived, seated: t.flow.callIn, finished: t.flow.finish, no_show: "", undo: "" };
  const icon: Partial<Record<FlowStep, React.ReactNode>> = {
    arrived: <Armchair className="h-3.5 w-3.5" />,
    seated: <DoorOpen className="h-3.5 w-3.5" />,
    finished: <CheckCheck className="h-3.5 w-3.5" />,
  };

  const nowMs = Date.now();
  const staged = rows.map((base) => {
    const ap = { ...base, ...moved[base.id] };
    return { base, ap, stage: flowStage({ status: ap.status, starts_at: ap.starts_at, arrived_at: ap.arrived_at, seated_at: ap.seated_at }, nowMs) };
  });
  const counts: Record<Group, number> = { all: staged.length, waiting: 0, in_room: 0, coming: 0, done: 0 };
  for (const r of staged) counts[groupOf(r.stage)]++;
  const shown = group === "all" ? staged : staged.filter((r) => groupOf(r.stage) === group);
  const groupLabel: Record<Group, string> = {
    all: t.common.all,
    waiting: t.flow.stages.waiting,
    in_room: t.flow.stages.in_room,
    coming: t.flow.stages.expected,
    done: t.flow.stages.finished,
  };

  return (
    <div data-today-list>
      {/* Who is where, at a glance — and a tap shows only them. */}
      <div className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-2.5 sm:px-5" data-today-groups>
        {(["all", "waiting", "in_room", "coming", "done"] as const)
          .filter((g) => g === "all" || counts[g] > 0 || group === g)
          .map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={group === g}
              onClick={() => setGroup(g)}
              data-today-group={g}
              className={`inline-flex h-8 shrink-0 touch-manipulation items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-140 ease-out ${
                group === g ? "bg-brand-600 text-on-brand" : "bg-ink-900/4 text-ink-700 hover:bg-ink-900/8"
              }`}
            >
              {groupLabel[g]}
              <span className="tnum opacity-75">{counts[g]}</span>
            </button>
          ))}
      </div>
    <ul className="divide-y divide-line">
      {shown.map(({ base, ap, stage }) => {
        const next = canFlow ? NEXT[stage] : undefined;
        const mine = !!selfMemberId && ap.doctor_member_id === selfMemberId;
        const href = canOpenPatient ? `/c/${slug}/patients/${ap.patient_id}` : `/c/${slug}/calendar?open=${ap.id}`;
        const badge =
          stage === "waiting" || stage === "in_room" || stage === "late" ? (
            <Badge status={stage}>{t.flow.stages[stage]}</Badge>
          ) : (
            <Badge status={apptStatus[ap.status] ?? "neutral"}>{(t.calendar.statuses as Record<string, string>)[ap.status] ?? ap.status}</Badge>
          );
        /*
          Doctors run their day from a phone, between rooms. There the stage
          sits under the name and the step keeps its word and a thumb's height,
          because an icon alone is a guess and a guess on a patient is a mistake.
        */
        return (
          <li
            key={ap.id}
            className="spine flex items-center gap-3 px-5 py-2.5 max-sm:ps-4 max-sm:pe-3"
            style={{ "--spine-color": ap.service_color ?? "var(--color-brand-600)" } as React.CSSProperties}
            data-today-row={ap.id}
            data-today-mine={mine ? "1" : undefined}
          >
            <Link href={href} className="-my-1 flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 hover:bg-sunken/60 sm:gap-4">
              <span className="w-12 shrink-0 text-sm font-semibold tnum sm:w-16">{fmtTime(ap.starts_at, tz, locale)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{ap.patient_name}</div>
                <div className="truncate text-[13px] text-ink-500">
                  {(locale === "ar" ? ap.service_name_ar : null) || ap.service_name || "—"}
                  {mine ? (
                    <span className="font-medium text-ink-700">{` · ${t.dashboard.you}`}</span>
                  ) : ap.doctor_name ? (
                    ` · ${ap.doctor_name}`
                  ) : (
                    ""
                  )}
                </div>
                <div className="mt-1 sm:hidden">{badge}</div>
              </div>
            </Link>
            <div className="max-sm:hidden">{badge}</div>
            {next && (
              <button
                type="button"
                disabled={busy === ap.id}
                onClick={() => (next === "finished" ? setFinishing(base) : step(base, next))}
                className="inline-flex h-10 shrink-0 touch-manipulation items-center gap-1.5 rounded-full bg-brand-600 px-3.5 text-[13px] font-semibold text-on-brand hover:bg-brand-hover active:opacity-80 disabled:opacity-60 sm:h-8 sm:px-3 sm:text-[12.5px]"
                data-today-action={next}
              >
                {icon[next]}
                {label[next]}
              </button>
            )}
          </li>
        );
      })}
    </ul>
      {finishing && (
        <FinishVisitSheet
          patientName={finishing.patient_name}
          serviceName={(locale === "ar" ? finishing.service_name_ar : null) || finishing.service_name}
          defaultDoctorId={null}
          defaultMinutes={null}
          busy={busy === finishing.id}
          onFinish={(h) => void step(finishing, "finished", h)}
          onClose={() => setFinishing(null)}
        />
      )}
    </div>
  );
}
