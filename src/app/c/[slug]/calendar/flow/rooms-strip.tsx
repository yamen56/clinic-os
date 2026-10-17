"use client";

import Link from "next/link";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { minutesBetween } from "@/lib/patient-flow";
import type { Appt, Room } from "../types";
import { DoorOpen, DoorClosed } from "lucide-react";

/**
 * Every room at a glance: free, or who is in it, with whom, for how long —
 * red once the visit has run past its time — and who is booked in next.
 *
 * A clinic without rooms sees a line saying what rooms would give it, linked
 * to where they are set up, rather than an empty strip.
 */
export function RoomsStrip({
  slug,
  rooms,
  appts,
  nowMs,
  tz,
  canSetUp,
}: {
  slug: string;
  rooms: Room[];
  /** Today's, not cancelled. */
  appts: Appt[];
  nowMs: number;
  tz: string;
  canSetUp: boolean;
}) {
  const { t, locale } = useI18n();
  if (!rooms.length) {
    return canSetUp ? (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-dashed border-line-strong bg-surface px-4 py-3 text-[13px] text-ink-500">
        <DoorOpen className="h-4 w-4 shrink-0 text-ink-400" />
        <span className="min-w-0 flex-1">{t.flow.noRoomsHint}</span>
        <Link href={`/c/${slug}/settings/rooms`} className="font-semibold text-ink-900 underline underline-offset-2">
          {t.flow.setUpRooms}
        </Link>
      </div>
    ) : null;
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]" data-rooms-strip>
      {rooms.map((r) => {
        const inside = appts.find(
          (a) => a.room_id === r.id && a.seated_at && !a.finished_at && ["pending_approval", "scheduled", "confirmed"].includes(a.status)
        );
        const next = appts
          .filter(
            (a) =>
              a.room_id === r.id &&
              !a.seated_at &&
              ["pending_approval", "scheduled", "confirmed"].includes(a.status) &&
              Date.parse(a.ends_at) > nowMs
          )
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
        const over = inside ? nowMs - Date.parse(inside.ends_at) > 60_000 : false;
        const name = (locale === "ar" && r.name_ar) || r.name;
        return (
          <div
            key={r.id}
            data-room-tile={r.name}
            data-room-busy={inside ? "1" : "0"}
            className={`relative min-w-[11rem] flex-1 overflow-hidden rounded-card border bg-surface px-3 py-2.5 shadow-card ${
              over ? "border-danger/40" : "border-line"
            }`}
          >
            <div className="flex items-center gap-2">
              {inside ? (
                <DoorClosed className="h-4 w-4 shrink-0 text-ink-500" strokeWidth={1.75} aria-hidden />
              ) : (
                <DoorOpen className="h-4 w-4 shrink-0 text-ink-400" strokeWidth={1.75} aria-hidden />
              )}
              <span className="truncate text-[13px] font-semibold text-ink-900">{name}</span>
              <span
                className={`ms-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  inside ? (over ? "bg-danger-soft text-danger" : "bg-sunken text-ink-700") : "bg-st-confirmed-soft text-st-confirmed"
                }`}
              >
                {inside
                  ? over
                    ? t.flow.overBy.replace("{n}", String(Math.floor((nowMs - Date.parse(inside.ends_at)) / 60_000)))
                    : t.flow.inFor.replace("{n}", String(minutesBetween(inside.seated_at!, nowMs)))
                  : t.flow.roomFree}
              </span>
            </div>
            {inside ? (
              <div className="mt-1 min-w-0">
                <div className="truncate text-[13px] font-medium text-ink-900">{inside.patient_name}</div>
                <div className="truncate text-[11.5px] text-ink-500">{inside.doctor_name ?? "—"}</div>
              </div>
            ) : (
              <div className="mt-1 h-[2.35rem] text-[11.5px] text-ink-400">
                {next && (
                  <span className="block truncate">
                    {t.flow.roomNext.replace("{time}", DateTime.fromISO(next.starts_at).setZone(tz).toFormat("H:mm"))} · {next.patient_name}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
