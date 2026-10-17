"use client";

import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { fmtMoney } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import { TakePayment } from "@/components/take-payment";
import { minutesBetween, type FlowStage } from "@/lib/patient-flow";
import type { FlowStep } from "../flow-actions";
import type { Appt, PageCaps, Room } from "../types";
import { Menu, MenuItem } from "./menu";
import {
  Armchair,
  DoorOpen,
  CheckCheck,
  MoreHorizontal,
  ChevronDown,
  UserX,
  Undo2,
  CalendarClock,
  UserRound,
  Phone,
  MessageCircle,
  ReceiptText,
  CalendarPlus,
  Clock,
  Stethoscope,
  DoorClosed,
  Minus,
} from "lucide-react";

/**
 * One patient on the board.
 *
 * Everything the desk and the doctor need without opening anything: when, who,
 * what for, with whom, in which room, how long they have been waiting or in
 * the chair — and the one step that moves them on, as the card's only big
 * button. Everything else is behind the "more" menu, so the button a busy
 * receptionist presses is never the wrong one.
 */
export function FlowCard({
  slug,
  appt,
  stage,
  nowMs,
  tz,
  rooms,
  occupants,
  caps,
  currency,
  busy,
  onStep,
  onOpen,
  onBookNext,
}: {
  slug: string;
  appt: Appt;
  stage: FlowStage;
  nowMs: number;
  tz: string;
  rooms: Room[];
  /** Who is in each room right now. */
  occupants: Map<string, { id: string; name: string }>;
  caps: PageCaps;
  currency: string;
  /** A step for this card is on its way. */
  busy: boolean;
  onStep: (step: FlowStep, roomId?: string | null) => void;
  onOpen: () => void;
  onBookNext: () => void;
}) {
  const { t, locale } = useI18n();
  // Taken here since the board last read: payments do not move the board, so it is counted off at once.
  const [paidHere, setPaidHere] = useState(0);
  useEffect(() => setPaidHere(0), [appt.balance_due]);
  const s = DateTime.fromISO(appt.starts_at).setZone(tz);
  const e = DateTime.fromISO(appt.ends_at).setZone(tz);
  const service = (locale === "ar" ? appt.service_name_ar : null) || appt.service_name;
  const room = (locale === "ar" && appt.room_name_ar) || appt.room_name;
  const roomName = (r: Room) => (locale === "ar" && r.name_ar) || r.name;

  /* The clock that matters at this stage. */
  let timer: { text: string; tone: "late" | "waiting" | "in_room" | "over" } | null = null;
  if (stage === "late") timer = { text: t.flow.lateBy.replace("{n}", String(minutesBetween(appt.starts_at, nowMs))), tone: "late" };
  else if (stage === "waiting" && appt.arrived_at) {
    const n = minutesBetween(appt.arrived_at, nowMs);
    timer = { text: t.flow.waitingFor.replace("{n}", String(n)), tone: n >= 20 ? "late" : "waiting" };
  } else if (stage === "in_room" && appt.seated_at) {
    const over = nowMs - Date.parse(appt.ends_at);
    timer =
      over > 60_000
        ? { text: t.flow.overBy.replace("{n}", String(Math.floor(over / 60_000))), tone: "over" }
        : { text: t.flow.inFor.replace("{n}", String(minutesBetween(appt.seated_at, nowMs))), tone: "in_room" };
  }
  /* Ink while all is well; orange or red only when the clock is a problem. */
  const toneClass = {
    late: "bg-st-late-soft text-st-late",
    waiting: "bg-sunken text-ink-700",
    in_room: "bg-sunken text-ink-700",
    over: "bg-danger-soft text-danger",
  };

  const tags: { key: string; text: string; status: "brand" | "pending" | "neutral" | "waiting" }[] = [];
  if (appt.first_visit) tags.push({ key: "first", text: t.flow.firstVisit, status: "brand" });
  if (appt.walk_in) tags.push({ key: "walk", text: t.flow.walkInTag, status: "neutral" });
  else if (appt.source === "booking_link") tags.push({ key: "online", text: t.flow.bookedOnline, status: "neutral" });
  else if (appt.source === "ai_agent") tags.push({ key: "ai", text: t.flow.bookedByAi, status: "neutral" });
  if (appt.status === "pending_approval") tags.push({ key: "pending", text: t.flow.awaitingApproval, status: "pending" });
  // A treatment is paid off over the visits: the desk sees what is still owed when the patient walks in.
  const owed = caps.invoices && currency ? Math.max(0, Math.round(((appt.balance_due ?? 0) - paidHere) * 100) / 100) : 0;
  if (owed > 0) tags.push({ key: "owes", text: t.invoices.owes.replace("{amount}", fmtMoney(owed, currency, locale)), status: "pending" });

  const canUndo =
    stage === "waiting" || stage === "in_room" || ((stage === "finished" || stage === "no_show") && !!appt.flow_prev_status);
  const phoneDigits = appt.patient_phone?.replace(/[^\d+]/g, "");

  /* One colour for the one next step, whatever it is; the label and icon say which. */
  const primary = "inline-flex h-9 touch-manipulation items-center justify-center gap-1.5 rounded-full bg-brand-600 px-3.5 text-[13px] font-semibold text-white shadow-card transition-opacity hover:bg-brand-700 active:opacity-80 disabled:opacity-60";

  return (
    <div
      data-flow-card={appt.id}
      data-stage={stage}
      className={`rounded-xl border bg-surface p-3 shadow-card transition-colors ${
        stage === "late" ? "border-st-late/40" : "border-line"
      } ${busy ? "opacity-70" : ""}`}
    >
      <div className="flex items-start gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-start">
          <div className="flex items-baseline gap-1.5 text-[12px] text-ink-500">
            <span className="text-[13px] font-bold text-ink-900 tnum">{s.toFormat("H:mm")}</span>
            <span className="tnum">– {e.toFormat("H:mm")}</span>
          </div>
          <div className={`mt-0.5 truncate text-[15px] font-semibold leading-snug ${stage === "no_show" ? "text-ink-400 line-through" : "text-ink-900"}`}>
            {appt.patient_name}
          </div>
        </button>
        {timer && (
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold tnum ${toneClass[timer.tone]}`}>
            <Clock className="h-3 w-3" />
            {timer.text}
          </span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-500">
        {service && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Stethoscope className="h-3.5 w-3.5 shrink-0 text-ink-400" />
            <span className="truncate">{service}</span>
          </span>
        )}
        {appt.doctor_name && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <UserRound className="h-3.5 w-3.5 shrink-0 text-ink-400" />
            <span className="truncate">{appt.doctor_name}</span>
          </span>
        )}
        {room && (
          <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-[11.5px] font-semibold text-ink-700">
            <DoorOpen className="h-3 w-3" />
            {room}
          </span>
        )}
      </div>

      {(tags.length > 0 || appt.notes) && (
        <div className="mt-2 grid gap-1.5">
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((x) => (
                <Badge key={x.key} status={x.status} className="!h-5 !px-2 !text-[11px]">
                  {x.text}
                </Badge>
              ))}
            </div>
          )}
          {appt.notes && <p className="line-clamp-2 whitespace-pre-line text-[12px] leading-snug text-ink-500">{appt.notes}</p>}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {(stage === "expected" || stage === "late") && (
          <button type="button" disabled={busy} onClick={() => onStep("arrived")} className={`${primary} flex-1`} data-flow-action="arrived">
            <Armchair className="h-4 w-4" />
            {t.flow.arrived}
          </button>
        )}
        {stage === "waiting" &&
          (rooms.length === 0 ? (
            <button type="button" disabled={busy} onClick={() => onStep("seated")} className={`${primary} flex-1`} data-flow-action="seated">
              <DoorOpen className="h-4 w-4" />
              {t.flow.callIn}
            </button>
          ) : (
            /* Into which room: the booked one first, the occupied ones named and closed. */
            <Menu
              label={t.flow.callIn}
              align="start"
              className="flex-1"
              buttonClassName={`${primary} w-full`}
              trigger={() => (
                <>
                  <DoorOpen className="h-4 w-4" />
                  {t.flow.callIn}
                  <ChevronDown className="h-3.5 w-3.5 opacity-80" />
                </>
              )}
            >
              {(close) => (
                <>
                  <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t.flow.seatIn}</div>
                  {[...rooms]
                    .sort((a, b) => (a.id === appt.room_id ? -1 : b.id === appt.room_id ? 1 : 0))
                    .map((r) => {
                      const occ = occupants.get(r.id);
                      return (
                        <MenuItem
                          key={r.id}
                          disabled={!!occ}
                          icon={occ ? <DoorClosed /> : <DoorOpen />}
                          hint={occ ? t.flow.occupiedBy.replace("{name}", occ.name) : r.id === appt.room_id ? t.calendar.bookedIn.replace("{room}", roomName(r)) : t.flow.roomFree}
                          onClick={() => {
                            close();
                            onStep("seated", r.id);
                          }}
                        >
                          {roomName(r)}
                        </MenuItem>
                      );
                    })}
                  <MenuItem
                    icon={<Minus />}
                    onClick={() => {
                      close();
                      onStep("seated", null);
                    }}
                  >
                    {t.flow.noRoom}
                  </MenuItem>
                </>
              )}
            </Menu>
          ))}
        {stage === "in_room" && (
          <button type="button" disabled={busy} onClick={() => onStep("finished")} className={`${primary} flex-1`} data-flow-action="finished">
            <CheckCheck className="h-4 w-4" />
            {t.flow.finish}
          </button>
        )}
        {stage === "finished" && (
          <div className="flex flex-1 flex-wrap gap-1.5">
            {caps.invoices && (
              <a
                href={`/c/${slug}/invoices/new?patient=${appt.patient_id}&appointment=${appt.id}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken"
              >
                <ReceiptText className="h-3.5 w-3.5" />
                {t.flow.createInvoice}
              </a>
            )}
            {owed > 0 && (
              <TakePayment
                slug={slug}
                patientId={appt.patient_id}
                balance={appt.balance_due ?? 0}
                currency={currency}
                onPaid={(n) => setPaidHere((x) => Math.round((x + n) * 100) / 100)}
              />
            )}
            <button
              type="button"
              onClick={onBookNext}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken"
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              {t.flow.bookNext}
            </button>
          </div>
        )}
        {stage === "no_show" && <span className="flex-1" />}

        <Menu
          label={t.flow.more}
          buttonClassName="grid h-9 w-9 shrink-0 touch-manipulation place-items-center rounded-full text-ink-500 transition-colors hover:bg-sunken active:bg-sunken"
          trigger={() => <MoreHorizontal className="h-4.5 w-4.5" />}
        >
          {(close) => (
            <>
              {(stage === "expected" || stage === "late" || stage === "waiting") && (
                <MenuItem
                  icon={<UserX />}
                  onClick={() => {
                    close();
                    onStep("no_show");
                  }}
                >
                  {t.flow.noShow}
                </MenuItem>
              )}
              {canUndo && (
                <MenuItem
                  icon={<Undo2 />}
                  onClick={() => {
                    close();
                    onStep("undo");
                  }}
                >
                  {t.flow.undo}
                </MenuItem>
              )}
              <MenuItem
                icon={<CalendarClock />}
                onClick={() => {
                  close();
                  onOpen();
                }}
              >
                {t.flow.openAppointment}
              </MenuItem>
              {caps.patients && (
                <MenuItem icon={<UserRound />} href={`/c/${slug}/patients/${appt.patient_id}`}>
                  {t.flow.patientFile}
                </MenuItem>
              )}
              {caps.conversations && caps.patients && (
                <MenuItem icon={<MessageCircle />} href={`/c/${slug}/patients/${appt.patient_id}?tab=conversation`}>
                  {t.flow.whatsapp}
                </MenuItem>
              )}
              {phoneDigits && (
                <MenuItem icon={<Phone />} href={`tel:${phoneDigits}`} hint={<span dir="ltr">{appt.patient_phone}</span>}>
                  {t.flow.call}
                </MenuItem>
              )}
              {stage !== "finished" && caps.invoices && (
                <MenuItem icon={<ReceiptText />} href={`/c/${slug}/invoices/new?patient=${appt.patient_id}&appointment=${appt.id}`}>
                  {t.flow.createInvoice}
                </MenuItem>
              )}
              {stage !== "finished" && (
                <MenuItem
                  icon={<CalendarPlus />}
                  onClick={() => {
                    close();
                    onBookNext();
                  }}
                >
                  {t.flow.bookNext}
                </MenuItem>
              )}
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}
