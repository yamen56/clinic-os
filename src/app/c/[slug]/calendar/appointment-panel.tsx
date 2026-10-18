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
import { scheduleErrorText, savedText } from "./messages";
import { RequiredDocuments } from "@/components/esign/required-documents";
import { AppointmentNotes } from "@/components/appointment-notes";
import { PatientPicker } from "@/components/appointments/patient-picker";
import type { Appt, Doctor, PlannedItem, Room, Section, Service } from "./types";
import { VisitLineView, whereOf } from "@/components/charts/dental/visit-work";
import { X, ClipboardList, Sparkles, Armchair, DoorOpen, CheckCheck, Undo2 } from "lucide-react";

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
}: {
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
  const [serviceId, setServiceId] = useState("");
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

  useEffect(() => {
    if (!state) return;
    setSuggested(null);
    if (state.mode === "create") {
      const s = state.start ? DateTime.fromISO(state.start).setZone(tz) : DateTime.now().setZone(tz).plus({ hours: 1 }).startOf("hour");
      const svc = services.find((x) => x.id === state.serviceId);
      setPatient(state.patient ?? null);
      setNewPatient(null);
      setServiceId(svc?.id ?? "");
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
      setServiceId(a.service_id ?? "");
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
          serviceId: serviceId || null,
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

  const flow = (step: FlowStep) =>
    start(async () => {
      if (state?.mode !== "edit") return;
      const r = await setFlowAction(slug, state.appt.id, step);
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
      toast(t.calendar.updated);
      onChanged();
    });

  const suggest = async () => {
    if (!serviceId) return;
    setSuggesting(true);
    try {
      const q = new URLSearchParams({ service: serviceId, limit: "6", ...(doctorId ? { doctor: doctorId } : {}), ...(date ? { from: date } : {}) });
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
                <span className="ms-auto flex flex-wrap items-center gap-1.5">
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
                    <Button size="sm" onClick={() => flow("finished")} loading={pending}>
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

            {/* Patient */}
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
                <PatientPicker slug={slug} onPick={setPatient} onCreateNew={() => setNewPatient({ fullName: "", phone: "" })} />
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

            <div className="grid grid-cols-2 gap-4">
              <Field label={t.calendar.service}>
                <Select
                  value={serviceId}
                  onChange={(e) => {
                    setServiceId(e.target.value);
                    setSuggested(null);
                    const s = services.find((x) => x.id === e.target.value);
                    if (s) setDuration(s.duration_min);
                  }}
                >
                  <option value="">{t.calendar.noService}</option>
                  {/* Grouped by section when the clinic has them, flat when it
                      does not — a single <optgroup> around every option is a
                      heading that separates nothing. */}
                  {sections.length === 0
                    ? services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {locale === "ar" ? s.name_ar || s.name : s.name}
                        </option>
                      ))
                    : [
                        ...sections.map((sec) => ({
                          key: sec.id,
                          label: locale === "ar" ? sec.name_ar || sec.name : sec.name,
                          items: services.filter((s) => s.section_id === sec.id),
                        })),
                        {
                          key: "__unfiled",
                          label: t.sections.unfiled,
                          items: services.filter((s) => !s.section_id),
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
              </Field>
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
            </div>

            {/* After the doctor, and only once the clinic has rooms. */}
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
                      <span className="text-[12px] text-ink-500">{t.calendar.noFreeTimes}</span>
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
                serviceName={(locale === "ar" ? editAppt.service_name_ar : null) ?? editAppt.service_name}
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
