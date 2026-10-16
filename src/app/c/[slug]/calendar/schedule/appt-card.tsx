"use client";

import { DateTime } from "luxon";
import { flowStage } from "@/lib/patient-flow";
import { tint } from "./grid-layout";
import type { Appt } from "../types";
import { CheckCircle2, Hourglass, DoorOpen, Armchair, Clock, Check } from "lucide-react";

/**
 * One visit on the time grid.
 *
 * A soft fill in the service's (or doctor's) colour with a solid edge, dark
 * ink on top — the old solid blocks put white or black text on whatever colour
 * a clinic had picked, and a pale service colour made its visits unreadable.
 * The status and where the patient is today ride in the corner as an icon, so
 * the desk sees at a glance who is waiting and who is in a room.
 *
 * The first line stays "{h:mm} {name}": it is how people and qa-phase3 find a
 * visit on the grid.
 */
export function ApptCard({
  appt,
  top,
  height,
  lane,
  lanes,
  color,
  tz,
  locale,
  showDoctor,
  showRoom,
  nowMs,
  lifted,
  statusLabel,
  onPointerDown,
  onResizeDown,
}: {
  appt: Appt;
  top: number;
  height: number;
  lane: number;
  lanes: number;
  color: string;
  tz: string;
  locale: string;
  showDoctor: boolean;
  showRoom: boolean;
  nowMs: number;
  /** Being dragged. */
  lifted: boolean;
  statusLabel: string;
  onPointerDown: (ev: React.PointerEvent) => void;
  onResizeDown: (ev: React.PointerEvent) => void;
}) {
  const s = DateTime.fromISO(appt.starts_at).setZone(tz);
  const stage = flowStage(
    { status: appt.status, starts_at: appt.starts_at, arrived_at: appt.arrived_at ?? null, seated_at: appt.seated_at ?? null },
    nowMs
  );
  const service = (locale === "ar" ? appt.service_name_ar : null) || appt.service_name || "";
  const room = (locale === "ar" && appt.room_name_ar) || appt.room_name;
  const dim = appt.status === "completed" || appt.status === "no_show";

  const Icon =
    stage === "in_room"
      ? DoorOpen
      : stage === "waiting"
        ? Armchair
        : stage === "late"
          ? Clock
          : appt.status === "pending_approval"
            ? Hourglass
            : appt.status === "completed"
              ? Check
              : appt.status === "confirmed"
                ? CheckCircle2
                : null;
  const iconColor =
    stage === "in_room"
      ? "var(--color-st-inroom)"
      : stage === "waiting"
        ? "var(--color-st-waiting)"
        : stage === "late"
          ? "var(--color-st-late)"
          : appt.status === "pending_approval"
            ? "var(--color-st-pending)"
            : appt.status === "confirmed"
              ? "var(--color-st-confirmed)"
              : "var(--color-ink-500)";

  return (
    <div
      data-appt
      data-appt-id={appt.id}
      data-flow={stage}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => e.preventDefault()}
      className={`absolute z-[5] cursor-grab select-none overflow-hidden rounded-md border text-ink-900 shadow-sm transition-shadow duration-140 [-webkit-touch-callout:none] hover:z-[6] hover:shadow-md ${
        appt.status === "pending_approval" ? "border-dashed" : ""
      } ${dim ? "opacity-60" : ""} ${appt.status === "no_show" ? "line-through" : ""} ${
        lifted ? "z-20 cursor-grabbing opacity-90 shadow-pop ring-2 ring-brand-400" : ""
      }`}
      style={{
        top,
        height,
        insetInlineStart: `calc(${(lane / lanes) * 100}% + 2px)`,
        width: `calc(${100 / lanes}% - 4px)`,
        background: tint(color, stage === "in_room" ? 24 : 15),
        borderColor: tint(color, 45),
      }}
      title={`${appt.patient_name} · ${statusLabel}`}
    >
      <span className="absolute inset-y-0 start-0 w-[3px]" style={{ background: color }} aria-hidden />
      {/*
        Text only, each line truncating as a whole. Three or more visits side
        by side make a lane a couple of letters wide; an icon or a chip inside
        it would stick out of the block rather than shrink.
      */}
      <div className="ps-2 pe-1 pt-0.5">
        {Icon && height > 22 && lanes < 3 && (
          <Icon className="float-end ms-0.5 mt-px h-3 w-3" style={{ color: iconColor }} aria-hidden />
        )}
        <div className="truncate text-[11px] font-semibold leading-tight tnum">
          {s.toFormat("h:mm")} {appt.patient_name}
        </div>
        {height > 34 && (service || (showRoom && room)) && (
          <div className="truncate text-[10px] leading-tight text-ink-700">
            {[service, showRoom ? room : null].filter(Boolean).join(" · ")}
          </div>
        )}
        {height > 50 && showDoctor && appt.doctor_name && (
          <div className="truncate text-[10px] leading-tight text-ink-500">{appt.doctor_name}</div>
        )}
      </div>
      {/* Resizing is a mouse gesture; on a touchscreen the handle only steals scrolls. */}
      <div
        data-resize="1"
        onPointerDown={onResizeDown}
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize pointer-coarse:hidden"
      />
    </div>
  );
}
