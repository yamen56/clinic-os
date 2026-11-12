"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Textarea } from "@/components/ui/input";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { flowStage, type FlowStage } from "@/lib/patient-flow";
import { createAppointmentAction, updateAppointmentAction, setAppointmentStatusAction } from "./actions";
import { setFlowAction, type FlowStep } from "./flow-actions";
import { addToWaitlistAction } from "../waitlist/actions";
import type { Handoff } from "./flow-actions";
import { FinishVisitSheet } from "@/components/appointments/finish-visit-sheet";
import { nextWhen } from "@/lib/next-visit";
import { scheduleErrorText, savedText } from "./messages";
import { RequiredDocuments } from "@/components/esign/required-documents";
import { AppointmentNotes } from "@/components/appointment-notes";
import { PatientPicker } from "@/components/appointments/patient-picker";
import type { Appt, Doctor, PlannedItem, Room, Section, Service } from "./types";
import { VisitLineView, whereOf } from "@/components/charts/dental/visit-work";
import { X, ClipboardList, Sparkles, Armchair, DoorOpen, CheckCheck, Undo2, ShieldAlert, Clock, UserPen } from "lucide-react";
import { flagAlerts } from "@/lib/medical-history";
import { MAX_VISIT_SERVICES } from "@/lib/appointment-services";
import { visitServiceLabel } from "@/lib/services";

export type PanelState =
  | null
  | {
      mode: "create";
      start?: string;
      doctorId?: string;
      serviceId?: string;
      roomId?: string;
      patient?: { id: string; name: string };
      items?: PlannedItem[];
      notes?: string;
    }
  | { mode: "edit"; appt: Appt };

const statusBadge: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

const stageBadge: Partial<Record<FlowStage, StatusKey>> = { waiting: "waiting", in_room: "in_room", late: "late" };

export function AppointmentPanel({
  slug,
  tz,
  state,
  onClose,
  onChanged,
  doctors,
  services,
  sections,
  rooms,
  known,
  nowMs,
  canSendDocuments,
  canOpenPatient,
  canInvoice = false,
  onBookNext,
  onLate,
}: {
  /** Running late — the same sheet as the board's, for a visit opened from the Schedule. */
  onLate?: (a: Appt) => void;
  /** May raise an invoice — a finished visit offers to bill it. */
  canInvoice?: boolean;
  /** Book the next visit from a finished one, on the day its hand-off asked for. */
  onBookNext?: (a: Appt) => void;
  slug: string;
  tz: string;
  state: PanelState;
  onClose: () => void;
  onChanged: () => void;
  doctors: Doctor[];
  services: Service[];
  sections: Section[];
  rooms: Room[];
  /** The visits the page already has, to say which rooms are busy at the chosen time before saving. */
  known: Appt[];
  nowMs: number;
  canSendDocuments: boolean;
  canOpenPatient: boolean;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [cancelOpen, setCancelOpen] = useState(false);

  // form state
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [newPatient, setNewPatient] = useState<{ fullName: string; phone: string } | null>(null);
  /** Every service the visit is for, the first one first — it is the visit's own (migration 0106). */
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const serviceId = serviceIds[0] ?? "";
  const [doctorId, setDoctorId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState("");
  /** The treatments on the patient's plan this visit is for. */
  const [items, setItems] = useState<PlannedItem[]>([]);
  const [suggested, setSuggested] = useState<{ startISO: string; doctorMemberId: string | null }[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [waitlisting, setWaitlisting] = useState(false);

  useEffect(() => {
    if (!state) return;
    setSuggested(null);
    if (state.mode === "create") {
      const s = state.start ? DateTime.fromISO(state.start).setZone(tz) : DateTime.now().setZone(tz).plus({ hours: 1 }).startOf("hour");
      const svc = services.find((x) => x.id === state.serviceId);
      setPatient(state.patient ?? null);
      setNewPatient(null);
      setServiceIds(svc ? [svc.id] : []);
      setDoctorId(state.doctorId ?? "");
      setRoomId(state.roomId ?? "");
      setDate(s.toISODate()!);
      setTime(s.toFormat("HH:mm"));
      setDuration(svc?.duration_min ?? 30);
      setNotes(state.notes ?? "");
      setItems(state.items ?? []);
    } else {
      const a = state.appt;
      const s = DateTime.fromISO(a.starts_at).setZone(tz);
      const e = DateTime.fromISO(a.ends_at).setZone(tz);
      setPatient({ id: a.patient_id, name: a.patient_name });
      setNewPatient(null);
      setServiceIds([a.service_id, ...(a.extra_services ?? []).map((x) => x.id)].filter((x): x is string => !!x));
      setDoctorId(a.doctor_member_id ?? "");
      setRoomId(a.room_id ?? "");
      setDate(s.toISODate()!);
      setTime(s.toFormat("HH:mm"));
      setDuration(Math.round(e.diff(s, "minutes").minutes));
      setNotes(a.notes ?? "");
      setItems(a.items ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, tz]);

  const startsAt = useMemo(
    () => (date && time ? DateTime.fromISO(`${date}T${time}`, { zone: tz }) : null),
    [date, time, tz]
  );

  /* Which rooms already have somebody at the chosen time, from what the page has loaded. */
  const busyRooms = useMemo(() => {
    const busy = new Set<string>();
    if (!startsAt) return busy;
    const s = startsAt.toMillis();
    const e = startsAt.plus({ minutes: duration }).toMillis();
    const self = state?.mode === "edit" ? state.appt.id : null;
    for (const a of known) {
      if (!a.room_id || a.id === self) continue;
      if (!["pending_approval", "scheduled", "confirmed"].includes(a.status)) continue;
      if (Date.parse(a.starts_at) < e && Date.parse(a.ends_at) > s) busy.add(a.room_id);
    }
    return busy;
  }, [known, startsAt, duration, state]);

  /*
    The visit's dental work in one box: what was done at it, then what it is
    still booked for. A treatment worked on at the visit is said once, as done.
  */
  const done = state?.mode === "edit" ? state.appt.done ?? [] : [];
  const worked = new Set(done.map((d) => d.markId));
  const planned = items.filter((i) => !worked.has(i.markId));
  // Said once, on the box's first heading.
  const chartLink =
    state?.mode === "edit" ? (
      <a href={`/c/${slug}/patients/${state.appt.patient_id}?tab=dental`} className="text-[12px] font-semibold text-brand-700 hover:underline">
        {t.calendar.openTreatment}
      </a>
    ) : null;

  const roomLabel = (r: Room) => (locale === "ar" && r.name_ar) || r.name;

  /*
    The services chosen, as the clinic names them. One the clinic has since
    switched off is not in `services` any more, so its name comes from the
    visit itself — a visit must keep saying what it was booked for.
  */
  const chosen = serviceIds.map((id) => {
    const s = services.find((x) => x.id === id);
    if (s) return { id, name: locale === "ar" ? s.name_ar || s.name : s.name, color: s.color, minutes: s.duration_min };
    const a = state?.mode === "edit" ? state.appt : null;
    const x = a?.extra_services?.find((e) => e.id === id);
    const name = x
      ? (locale === "ar" && x.name_ar) || x.name
      : a && a.service_id === id
        ? (locale === "ar" && a.service_name_ar) || a.service_name || ""
        : "";
    return { id, name, color: null as string | null, minutes: x?.duration_min ?? (a?.service_id === id ? (a.service_duration_min ?? 0) : 0) };
  });
  /** The visit is as long as its services together; the length stays the desk's to change after. */
  const changeServices = (next: string[]) => {
    setServiceIds(next);
    setSuggested(null);
    const total = next.reduce((n, id) => n + (services.find((x) => x.id === id)?.duration_min ?? 0), 0);
    if (total > 0) setDuration(Math.min(total, 480));
  };
  const addable = services.filter((s) => !serviceIds.includes(s.id));

  const submit = () =>
    start(async () => {
      if (!startsAt) return;
      const endsAt = startsAt.plus({ minutes: duration });
      if (state?.mode === "create") {
        const r = await createAppointmentAction(slug, {
          patientId: patient?.id,
          newPatient: newPatient ?? undefined,
          doctorMemberId: doctorId || null,
          serviceId: serviceId || null,
          serviceIds,
          startsAt: startsAt.toUTC().toISO()!,
          endsAt: endsAt.toUTC().toISO()!,
          notes,
          markIds: items.map((i) => i.markId),
          roomId: roomId || null,
        });
        if (r.error) {
          toast(scheduleErrorText(t, r), "error");
          return;
        }
        toast(r.roomName ? `${t.calendar.created} · ${t.calendar.bookedIn.replace("{room}", r.roomName)}` : t.calendar.created);
        onChanged();
      } else if (state?.mode === "edit") {
        /*
          The room it already had means "keep it if it still works, otherwise
          find one" — so changing only the time does not fail on a room that
          is taken when another is free. A different room is exactly that room.
        */
        const r = await updateAppointmentAction(slug, state.appt.id, {
          doctorMemberId: doctorId || null,
          serviceIds,
          startsAt: startsAt.toUTC().toISO()!,
          endsAt: endsAt.toUTC().toISO()!,
          notes,
          roomId: roomId === (state.appt.room_id ?? "") ? undefined : roomId || null,
        });
        if (r.error) {
          toast(scheduleErrorText(t, r), "error");
          return;
        }
        toast(savedText(t, t.calendar.updated, r));
        onChanged();
      }
    });

  const setStatus = (status: Parameters<typeof setAppointmentStatusAction>[2]) =>
    start(async () => {
      if (state?.mode !== "edit") return;
      const r = await setAppointmentStatusAction(slug, state.appt.id, status);
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.calendar.updated);
      onChanged();
    });

  const [finishing, setFinishing] = useState(false);
  /*
    `bookNext`: finished from the sheet's "Another time…" — once the visit is
    finished, the booking opens on the day the doctor asked for. A time picked
    on the sheet that went meanwhile does the same.
  */
  const flow = (step: FlowStep, handoff?: Handoff | null, bookNext?: boolean) =>
    start(async () => {
      if (state?.mode !== "edit") return;
      const appt = state.appt;
      const r = await setFlowAction(slug, appt.id, step, handoff ? { handoff } : {});
      setFinishing(false);
      if (r.error) {
        toast(
          r.error === "room_occupied"
            ? t.flow.roomOccupied.replace("{name}", r.occupiedBy ?? "")
            : r.error === "not_today"
              ? t.flow.notToday
              : t.flow.stale,
          "error"
        );
        return;
      }
      if (r.booked) {
        toast(
          t.finishVisit.finishedBooked.replace(
            "{when}",
            DateTime.fromISO(r.booked.startsAt).setZone(tz).setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB").toFormat("ccc d LLL · H:mm")
          )
        );
      } else if (r.bookError) {
        toast(t.finishVisit.bookFailed, "error");
      } else {
        toast(t.calendar.updated);
      }
      onChanged();
      if (handoff && onBookNext && (bookNext || r.bookError)) {
        onBookNext({
          ...appt,
          finished_at: new Date().toISOString(),
          next_visit_days: handoff.nextDays,
          next_visit_member_id: handoff.nextMemberId,
        });
      }
    });

  const suggest = async () => {
    if (!serviceId) return;
    setSuggesting(true);
    try {
      const q = new URLSearchParams({ service: serviceId, limit: "6", ...(doctorId ? { doctor: doctorId } : {}), ...(date ? { from: date } : {}) });
      // Every further service too, so a free time is long enough for all of them.
      for (const id of serviceIds.slice(1)) q.append("also", id);
      const res = await fetch(`/api/c/${slug}/free-slots?${q}`);
      setSuggested(res.ok ? (await res.json()).slots : []);
    } finally {
      setSuggesting(false);
    }
  };

  if (!state) return null;

  const today = DateTime.fromMillis(nowMs).setZone(tz).toISODate();
  const editAppt = state.mode === "edit" ? state.appt : null;
  const isToday = !!editAppt && DateTime.fromISO(editAppt.starts_at).setZone(tz).toISODate() === today;
  const stage = editAppt
    ? flowStage(
        { status: editAppt.status, starts_at: editAppt.starts_at, arrived_at: editAppt.arrived_at ?? null, seated_at: editAppt.seated_at ?? null },
        nowMs
      )
    : null;
  const canFlow = isToday && !!stage && stage !== "hidden";

  /* Who booked the visit, in a line: by whom or through what, then when. */
  const bookedBy = !editAppt
    ? ""
    : editAppt.walk_in
      ? editAppt.created_by_name
        ? t.calendar.walkInBy.replace("{name}", editAppt.created_by_name)
        : t.flow.walkInTag
      : editAppt.source === "booking_link"
        ? editAppt.booking_link_name
          ? t.calendar.bookedOnlineVia.replace("{link}", editAppt.booking_link_name)
          : t.flow.bookedOnline
        : editAppt.source === "ai_agent"
          ? t.calendar.bookedByAiFull
          : editAppt.source === "automation"
            ? t.flow.bookedByAutomation
            : editAppt.created_by_name
              ? t.calendar.bookedBy.replace("{name}", editAppt.created_by_name)
              : "";
  const bookedLine =
    bookedBy && editAppt?.created_at
      ? `${bookedBy} · ${DateTime.fromISO(editAppt.created_at)
          .setZone(tz)
          .setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB")
          .toFormat("ccc d LLL · H:mm")}`
      : bookedBy;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-900/20 animate-fade-in md:bg-transparent" onClick={onClose} />
      <aside className="fixed inset-y-0 end-0 z-50 flex w-full max-w-md flex-col border-s border-line bg-surface shadow-pop animate-fade-up md:animate-fade-in">
        <header className="flex items-center justify-between gap-2 border-b border-line px-5 py-3.5 pt-[max(0.875rem,env(safe-area-inset-top))]">
          <h2 className="text-[15px] font-semibold">
            {state.mode === "create" ? t.calendar.newAppointment : t.calendar.editAppointment}
          </h2>
          <div className="flex items-center gap-2">
            {editAppt && (
              <Badge status={statusBadge[editAppt.status]}>
                {(t.calendar.statuses as Record<string, string>)[editAppt.status]}
              </Badge>
            )}
            <button onClick={onClose} aria-label={t.common.close} className="rounded-md p-1.5 text-ink-500 hover:bg-ink-900/5">
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-4">
            {/*
              Where the patient is today, and the one step that moves them on —
              the same as the board, for whoever opened the visit from the
              calendar instead.
            */}
            {canFlow && editAppt && stage && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5" data-panel-flow={stage}>
                <Badge status={stageBadge[stage] ?? statusBadge[editAppt.status] ?? "neutral"}>
                  {(t.flow.stages as Record<string, string>)[stage]}
                </Badge>
                {!!editAppt.late_min && (stage === "expected" || stage === "late" || stage === "waiting") && (
                  <span className="text-[12.5px] text-ink-500" data-panel-said-late>
                    {t.flow.saidLate.replace("{n}", String(editAppt.late_min))}
                  </span>
                )}
                <span className="ms-auto flex flex-wrap items-center gap-1.5">
                  {onLate && (stage === "expected" || stage === "late" || stage === "waiting") && (
                    <Button size="sm" variant="outline" onClick={() => onLate(editAppt)} disabled={pending} data-panel-late>
                      <Clock className="h-4 w-4" />
                      {t.flow.runningLate}
                    </Button>
                  )}
                  {(stage === "expected" || stage === "late") && (
                    <Button size="sm" onClick={() => flow("arrived")} loading={pending}>
                      <Armchair className="h-4 w-4" />
                      {t.flow.arrived}
                    </Button>
                  )}
                  {stage === "waiting" && (
                    <Button size="sm" onClick={() => flow("seated")} loading={pending}>
                      <DoorOpen className="h-4 w-4" />
                      {t.flow.callIn}
                    </Button>
                  )}
                  {stage === "in_room" && (
                    <Button size="sm" onClick={() => setFinishing(true)} loading={pending}>
                      <CheckCheck className="h-4 w-4" />
                      {t.flow.finish}
                    </Button>
                  )}
                  {(stage === "waiting" || stage === "in_room" || ((stage === "finished" || stage === "no_show") && !!editAppt.flow_prev_status)) && (
                    <Button size="sm" variant="ghost" onClick={() => flow("undo")} disabled={pending}>
                      <Undo2 className="h-4 w-4" />
                      {t.flow.undo}
                    </Button>
                  )}
                </span>
              </div>
            )}

            {/*
              A finished visit, wherever it is opened: what the doctor handed on,
              and the desk's next steps — bill it, book the next one. It used
              to offer only Undo here, so checkout worked from the board alone.
            */}
            {editAppt && editAppt.status === "completed" && (canInvoice || onBookNext) && (
              <div className="grid gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5" data-panel-checkout>
                {/* What became of the next visit: booked and when, still to book, or not needed — as the board's card says it. */}
                {(editAppt.next_booked_at ||
                  (editAppt.handed_off_at && (editAppt.next_visit_days || editAppt.desk_note || editAppt.next_visit_none))) && (
                  <div className="grid gap-0.5 text-[12.5px]" data-panel-next>
                    {editAppt.next_booked_at ? (
                      <span className="font-semibold text-st-confirmed" data-panel-next-state="booked">
                        {t.finishVisit.bookedFor.replace(
                          "{when}",
                          DateTime.fromISO(editAppt.next_booked_at).setZone(tz).setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB").toFormat("ccc d LLL · H:mm")
                        )}
                      </span>
                    ) : editAppt.next_visit_days ? (
                      <span className="font-semibold" data-panel-next-state="not_booked">
                        {t.finishVisit.notBookedYet.replace("{when}", nextWhen(editAppt.next_visit_days, t.finishVisit.inDays))}
                      </span>
                    ) : editAppt.next_visit_none ? (
                      <span className="font-semibold" data-panel-next-state="none">{t.finishVisit.nextNone}</span>
                    ) : null}
                    {editAppt.desk_note && (
                      <span dir="auto" className="whitespace-pre-line text-ink-700">
                        {editAppt.desk_note}
                      </span>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {canInvoice &&
                    (editAppt.invoice ? (
                      <Link href={`/c/${slug}/invoices/${editAppt.invoice.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-st-confirmed-soft px-3 text-[12.5px] font-semibold text-st-confirmed">
                        <CheckCheck className="h-3.5 w-3.5" />
                        {(editAppt.invoice.paid ? t.flow.paidInvoice : t.flow.billedInvoice).replace("{number}", editAppt.invoice.number)}
                      </Link>
                    ) : (
                      <Link
                        href={`/c/${slug}/invoices/new?patient=${editAppt.patient_id}&appointment=${editAppt.id}`}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken"
                      >
                        {t.flow.createInvoice}
                      </Link>
                    ))}
                  {onBookNext && (
                    <button
                      type="button"
                      onClick={() => onBookNext(editAppt)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-brand-600 px-3 text-[12.5px] font-semibold text-on-brand hover:bg-brand-hover"
                      data-panel-book-next
                    >
                      {t.flow.bookNext}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Patient — and, before anything else about the visit, what must not be missed. */}
            {editAppt && flagAlerts(editAppt.medical, locale).length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-panel-medical>
                {flagAlerts(editAppt.medical, locale).map((a) => (
                  <Badge key={a} status="danger">
                    <ShieldAlert className="h-3 w-3" />
                    {a}
                  </Badge>
                ))}
              </div>
            )}
            <Field label={t.calendar.patient} required>
              {patient ? (
                <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
                  <Avatar name={patient.name} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{patient.name}</span>
                  {editAppt?.first_visit && <Badge status="brand">{t.flow.firstVisit}</Badge>}
                  {state.mode === "edit" && canOpenPatient && (
                    <Link href={`/c/${slug}/patients/${patient.id}`} className="text-[12px] font-semibold text-brand-700 hover:underline">
                      {t.flow.patientFile}
                    </Link>
                  )}
                  {state.mode === "create" && (
                    <button onClick={() => setPatient(null)} aria-label={t.common.delete} className="text-ink-400 hover:text-danger">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ) : newPatient ? (
                <div className="grid gap-2 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
                  <Input
                    placeholder={t.patients.fullName}
                    value={newPatient.fullName}
                    onChange={(e) => setNewPatient({ ...newPatient, fullName: e.target.value })}
                    autoFocus
                  />
                  <Input
                    dir="ltr"
                    placeholder="xxxxxxxxxx"
                    value={newPatient.phone}
                    onChange={(e) => setNewPatient({ ...newPatient, phone: e.target.value })}
                  />
                  <button onClick={() => setNewPatient(null)} className="justify-self-start text-[12px] text-ink-500 underline">
                    {t.common.cancel}
                  </button>
                </div>
              ) : (
                <PatientPicker slug={slug} onPick={setPatient} onCreateNew={setNewPatient} />
              )}
              {/*
                Who booked it, and when (Yamen, 2026-11-12: "mention who created
                this appointment, or that it came from the scheduling link").
                The staff member, the booking link by its name, the AI
                receptionist or an automation — whichever it was.
              */}
              {bookedLine && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-500" data-booked-by={editAppt?.walk_in ? "walk_in" : editAppt?.source}>
                  <UserPen className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                  <span className="min-w-0">{bookedLine}</span>
                </p>
              )}
            </Field>

            {/*
              The visit's dental work: what was done at it, from the chart —
              each treatment done here, each step of one — and what it was
              booked for from the patient's plan, so the doctor and the
              assistant know before the patient sits down.
            */}
            {(done.length > 0 || planned.length > 0) && (
              <div className="grid gap-3 rounded-lg border border-line bg-canvas p-3">
                {done.length > 0 && (
                  <div className="grid gap-1.5" data-done-at-visit={done.length}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-ink-500">{t.calendar.doneAtVisit}</span>
                      {chartLink}
                    </div>
                    <ul className="grid gap-1">
                      {done.map((d) => (
                        <li key={d.markId} data-done-item={d.markId}>
                          <VisitLineView line={d} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {planned.length > 0 && (
                  <div className="grid gap-1.5" data-planned-treatment>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-ink-500">{t.calendar.plannedTreatment}</span>
                      {done.length === 0 && chartLink}
                    </div>
                    <ul className="grid gap-1">
                      {planned.map((i) => (
                        <li key={i.markId} className="flex items-center gap-2 text-[13px]" data-planned-item={i.markId}>
                          <span className="grid h-6 min-w-6 place-items-center rounded-md bg-surface px-1.5 text-[12px] font-bold tnum shadow-card" dir="ltr">
                            {whereOf(i.site, t)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {(locale === "ar" && i.labelAr) || i.label}
                            {i.next && <span className="text-ink-500"> · {i.next}</span>}
                          </span>
                          {state.mode === "create" && (
                            <button onClick={() => setItems((xs) => xs.filter((x) => x.markId !== i.markId))} aria-label={t.common.delete} className="text-ink-400 hover:text-danger">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/*
              What the visit is for — one service or several (Yamen, 2026-11-12:
              "to make the doctor see that this patient will do more than one
              service"). Each one chosen is a chip; the list below adds another.
              It stays the panel's first <select> and the doctor its second,
              which is how the QA scripts find them.
            */}
            <Field label={t.calendar.service}>
              {chosen.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5" data-visit-services={chosen.length}>
                  {chosen.map((s) => (
                    <span
                      key={s.id}
                      data-visit-service={s.id}
                      className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-surface ps-2.5 pe-0.5 text-[13px] font-medium text-ink-900"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color ?? "var(--color-ink-300)" }} aria-hidden />
                      <span className="truncate">{s.name}</span>
                      {s.minutes > 0 && (
                        <span className="shrink-0 text-[11.5px] font-normal text-ink-500 tnum">{t.finishVisit.minutes.replace("{n}", String(s.minutes))}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => changeServices(serviceIds.filter((x) => x !== s.id))}
                        aria-label={t.calendar.removeService.replace("{name}", s.name)}
                        className="grid h-7 w-7 shrink-0 touch-manipulation place-items-center rounded-full text-ink-400 hover:bg-sunken hover:text-danger"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <Select
                value=""
                disabled={chosen.length >= MAX_VISIT_SERVICES}
                onChange={(e) => {
                  if (e.target.value) changeServices([...serviceIds, e.target.value]);
                }}
                data-add-service
              >
                <option value="">
                  {chosen.length === 0 ? t.calendar.noService : chosen.length === 1 ? t.calendar.addAnotherService : t.calendar.addService}
                </option>
                {/* Grouped by section when the clinic has them, flat when it
                    does not — a single <optgroup> around every option is a
                    heading that separates nothing. */}
                {sections.length === 0
                  ? addable.map((s) => (
                      <option key={s.id} value={s.id}>
                        {locale === "ar" ? s.name_ar || s.name : s.name}
                      </option>
                    ))
                  : [
                      ...sections.map((sec) => ({
                        key: sec.id,
                        label: locale === "ar" ? sec.name_ar || sec.name : sec.name,
                        items: addable.filter((s) => s.section_id === sec.id),
                      })),
                      {
                        key: "__unfiled",
                        label: t.sections.unfiled,
                        items: addable.filter((s) => !s.section_id),
                      },
                    ]
                      .filter((g) => g.items.length > 0)
                      .map((g) => (
                        <optgroup key={g.key} label={g.label}>
                          {g.items.map((s) => (
                            <option key={s.id} value={s.id}>
                              {locale === "ar" ? s.name_ar || s.name : s.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
              </Select>
              {chosen.length > 1 && (
                <p className="mt-1.5 text-[12px] text-ink-500" data-visit-services-total>
                  {t.calendar.servicesTotal
                    .replace("{n}", String(chosen.length))
                    .replace("{min}", String(chosen.reduce((n, s) => n + s.minutes, 0)))}
                </p>
              )}
            </Field>

            <div className={rooms.length > 0 ? "grid grid-cols-2 gap-4" : "grid gap-4"}>
              <Field label={t.calendar.doctor}>
                <Select
                  value={doctorId}
                  onChange={(e) => {
                    setDoctorId(e.target.value);
                    setSuggested(null);
                  }}
                >
                  <option value="">{t.calendar.noDoctor}</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* Beside the doctor, and only once the clinic has rooms. */}
              {rooms.length > 0 && (
                <Field label={t.calendar.room}>
                  <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} data-room-select>
                    <option value="">{t.calendar.autoRoom}</option>
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {roomLabel(r)}
                        {busyRooms.has(r.id) ? ` — ${t.calendar.roomBusy}` : ""}
                      </option>
                    ))}
                    {/* A room since taken out of use still names where this visit was. */}
                    {editAppt?.room_id && !rooms.some((r) => r.id === editAppt.room_id) && (
                      <option value={editAppt.room_id}>{(locale === "ar" && editAppt.room_name_ar) || editAppt.room_name}</option>
                    )}
                  </Select>
                </Field>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label={t.common.date}>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label={t.common.time}>
                <Input type="time" value={time} step={900} onChange={(e) => setTime(e.target.value)} />
              </Field>
              <Field label={t.calendar.duration}>
                <NumberInput dir="ltr" min={5} step={5} value={duration} onChange={(v) => setDuration(v)} fallback={30} />
              </Field>
            </div>

            {/* The next free times for this service and doctor, rooms and all. */}
            {(state.mode === "create" || (editAppt && editAppt.status !== "completed")) && (
              <div className="-mt-1 grid gap-2">
                <button
                  type="button"
                  onClick={suggest}
                  disabled={!serviceId || suggesting}
                  title={serviceId ? undefined : t.calendar.pickService}
                  className="flex items-center gap-1.5 justify-self-start text-[12.5px] font-semibold text-brand-700 hover:underline disabled:cursor-default disabled:text-ink-300 disabled:no-underline"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {t.calendar.suggestTimes}
                </button>
                {suggested && (
                  <div className="flex flex-wrap gap-1.5" data-suggested>
                    {suggested.length === 0 ? (
                      /*
                        Nothing free is where the waitlist begins: the patient,
                        the doctor and the service are already chosen, so one
                        press puts them in line for the first cancellation.
                      */
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] text-ink-500">{t.calendar.noFreeTimes}</span>
                        {patient && (
                          <button
                            type="button"
                            disabled={waitlisting}
                            onClick={async () => {
                              setWaitlisting(true);
                              const r = await addToWaitlistAction(slug, {
                                patientId: patient.id,
                                doctorMemberId: doctorId || null,
                                serviceId: serviceId || null,
                                earliestDate: date || null,
                              }).finally(() => setWaitlisting(false));
                              if (r.error) toast(r.error === "already_waiting" ? t.waitlist.alreadyWaiting : t.common.genericError, "error");
                              else toast(t.waitlist.added);
                            }}
                            className="rounded-full border border-brand-200 px-2.5 py-1 text-[12px] font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-60"
                            data-panel-waitlist
                          >
                            {t.waitlist.add}
                          </button>
                        )}
                      </span>
                    ) : (
                      suggested.map((s) => {
                        const d = DateTime.fromISO(s.startISO).setZone(tz).setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB");
                        return (
                          <button
                            key={`${s.startISO}${s.doctorMemberId}`}
                            type="button"
                            onClick={() => {
                              setDate(d.toISODate()!);
                              setTime(d.toFormat("HH:mm"));
                              if (!doctorId && s.doctorMemberId) setDoctorId(s.doctorMemberId);
                            }}
                            className="rounded-full border border-line-strong px-2.5 py-1 text-[12px] font-medium text-ink-700 transition-colors hover:border-brand-400 hover:bg-brand-50"
                          >
                            {d.toFormat("ccc d LLL")} · <span className="tnum">{d.toFormat("H:mm")}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}

            <Field label={t.common.notes}>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-20" />
            </Field>

            {/*
              What the patient told the booking page, read-only. It is a record
              of what was said at a moment, not a field to correct — staff who
              disagree with it write a note or fix the patient file instead.
            */}
            {editAppt && editAppt.intake_answers?.length > 0 && (
              <div>
                <span className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-ink-900">
                  <ClipboardList className="h-3.5 w-3.5 text-ink-400" />
                  {t.calendar.bookingAnswers}
                </span>
                <dl className="divide-y divide-line rounded-lg border border-line bg-sunken/40">
                  {editAppt.intake_answers.map((a) => (
                    <div key={a.id} className="px-3 py-2">
                      <dt className="text-[12px] text-ink-500">{locale === "ar" ? a.labelAr || a.label : a.label}</dt>
                      <dd className="whitespace-pre-line text-[13px] font-medium text-ink-900">
                        {a.type === "checkbox" ? (a.value === "yes" ? t.common.yes : t.common.no) : a.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {editAppt && <RequiredDocuments slug={slug} appointmentId={editAppt.id} canSend={canSendDocuments} />}

            {/*
              Notes about this visit, written where the visit is. The same
              records the patient file shows, filed against this appointment —
              see components/appointment-notes.
            */}
            {editAppt && (
              <AppointmentNotes
                slug={slug}
                appointmentId={editAppt.id}
                patientId={editAppt.patient_id}
                patientName={editAppt.patient_name}
                startsAt={editAppt.starts_at}
                serviceName={visitServiceLabel(editAppt, locale) || null}
                tz={tz}
              />
            )}

            {editAppt && (
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{t.common.status}</span>
                <div className="flex flex-wrap gap-1.5">
                  {(["scheduled", "confirmed", "completed", "no_show"] as const).map((s) => (
                    <button
                      key={s}
                      disabled={pending || editAppt.status === s}
                      onClick={() => setStatus(s)}
                      className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-default ${
                        editAppt.status === s ? "ring-2 ring-brand-400" : "hover:opacity-80"
                      }`}
                      style={{
                        background: `var(--color-st-${s === "no_show" ? "noshow" : s}-soft)`,
                        color: `var(--color-st-${s === "no_show" ? "noshow" : s})`,
                      }}
                    >
                      {(t.calendar.statuses as Record<string, string>)[s]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
          {editAppt && editAppt.status !== "cancelled" ? (
            <Button variant="ghost" className="!text-danger" onClick={() => setCancelOpen(true)}>
              {t.calendar.deleteAppointment}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={submit}
              loading={pending}
              disabled={!startsAt || (state.mode === "create" && !patient && !newPatient?.fullName.trim())}
            >
              {t.common.save}
            </Button>
          </div>
        </footer>
      </aside>

      {finishing && editAppt && (
        <FinishVisitSheet
          slug={slug}
          tz={tz}
          serviceId={editAppt.service_id}
          onAnotherTime={onBookNext ? (h) => flow("finished", h, true) : undefined}
          patientName={editAppt.patient_name}
          serviceName={visitServiceLabel(editAppt, locale) || null}
          done={done}
          doctors={doctors.map((d) => ({ id: d.id, name: d.name }))}
          defaultDoctorId={editAppt.doctor_member_id}
          defaultMinutes={editAppt.service_duration_min ?? null}
          busy={pending}
          onFinish={(h) => flow("finished", h)}
          onClose={() => setFinishing(false)}
        />
      )}
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t.calendar.deleteAppointment}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.calendar.deleteAppointment}
        cancelLabel={t.common.back}
        onConfirm={() => {
          setCancelOpen(false);
          setStatus("cancelled");
        }}
      />
    </>
  );
}
