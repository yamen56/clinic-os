"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { formatPhone } from "@/lib/phone";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  createAppointmentAction,
  updateAppointmentAction,
  setAppointmentStatusAction,
} from "./actions";
import type { Appt, Doctor, Service } from "./calendar-client";
import { X, UserPlus } from "lucide-react";

export type PanelState =
  | null
  | { mode: "create"; start?: string; doctorId?: string; patient?: { id: string; name: string } }
  | { mode: "edit"; appt: Appt };

const statusBadge: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

export function AppointmentPanel({
  slug,
  tz,
  state,
  onClose,
  onChanged,
  doctors,
  services,
}: {
  slug: string;
  tz: string;
  state: PanelState;
  onClose: () => void;
  onChanged: () => void;
  doctors: Doctor[];
  services: Service[];
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
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!state) return;
    if (state.mode === "create") {
      const s = state.start ? DateTime.fromISO(state.start).setZone(tz) : DateTime.now().setZone(tz).plus({ hours: 1 }).startOf("hour");
      setPatient(state.patient ?? null);
      setNewPatient(null);
      setServiceId("");
      setDoctorId(state.doctorId ?? "");
      setDate(s.toISODate()!);
      setTime(s.toFormat("HH:mm"));
      setDuration(30);
      setNotes("");
    } else {
      const a = state.appt;
      const s = DateTime.fromISO(a.starts_at).setZone(tz);
      const e = DateTime.fromISO(a.ends_at).setZone(tz);
      setPatient({ id: a.patient_id, name: a.patient_name });
      setNewPatient(null);
      setServiceId(a.service_id ?? "");
      setDoctorId(a.doctor_member_id ?? "");
      setDate(s.toISODate()!);
      setTime(s.toFormat("HH:mm"));
      setDuration(Math.round(e.diff(s, "minutes").minutes));
      setNotes(a.notes ?? "");
    }
  }, [state, tz]);

  const startsAt = useMemo(
    () => (date && time ? DateTime.fromISO(`${date}T${time}`, { zone: tz }) : null),
    [date, time, tz]
  );

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
        });
        if (r.error === "conflict") {
          toast(`${t.calendar.conflict}${r.conflictWith ? ` (${r.conflictWith})` : ""}`, "error");
          return;
        }
        if (r.error) {
          toast(r.error === "patient_required" ? t.common.required : t.common.genericError, "error");
          return;
        }
        toast(t.calendar.created);
        onChanged();
      } else if (state?.mode === "edit") {
        const r = await updateAppointmentAction(slug, state.appt.id, {
          doctorMemberId: doctorId || null,
          serviceId: serviceId || null,
          startsAt: startsAt.toUTC().toISO()!,
          endsAt: endsAt.toUTC().toISO()!,
          notes,
        });
        if (r.error === "conflict") {
          toast(`${t.calendar.conflict}${r.conflictWith ? ` (${r.conflictWith})` : ""}`, "error");
          return;
        }
        if (r.error) {
          toast(t.common.genericError, "error");
          return;
        }
        toast(t.calendar.updated);
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

  if (!state) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-900/20 animate-fade-in md:bg-transparent" onClick={onClose} />
      <aside className="fixed inset-y-0 inset-inline-end-0 z-50 flex w-full max-w-md flex-col border-s border-line bg-surface shadow-pop animate-fade-up md:animate-fade-in">
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">
            {state.mode === "create" ? t.calendar.newAppointment : t.calendar.editAppointment}
          </h2>
          <div className="flex items-center gap-2">
            {state.mode === "edit" && (
              <Badge status={statusBadge[state.appt.status]}>
                {(t.calendar.statuses as Record<string, string>)[state.appt.status]}
              </Badge>
            )}
            <button onClick={onClose} aria-label={t.common.close} className="rounded-md p-1.5 text-ink-500 hover:bg-ink-900/5">
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-4">
            {/* Patient */}
            <Field label={t.calendar.patient} required>
              {patient ? (
                <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
                  <Avatar name={patient.name} size={28} />
                  <span className="flex-1 text-sm font-medium">{patient.name}</span>
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
                    placeholder="0790744070"
                    value={newPatient.phone}
                    onChange={(e) => setNewPatient({ ...newPatient, phone: e.target.value })}
                  />
                  <button onClick={() => setNewPatient(null)} className="justify-self-start text-[12px] text-ink-500 underline">
                    {t.common.cancel}
                  </button>
                </div>
              ) : (
                <PatientPicker
                  slug={slug}
                  onPick={setPatient}
                  onCreateNew={() => setNewPatient({ fullName: "", phone: "" })}
                />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label={t.calendar.service}>
                <Select
                  value={serviceId}
                  onChange={(e) => {
                    setServiceId(e.target.value);
                    const s = services.find((x) => x.id === e.target.value);
                    if (s) setDuration(s.duration_min);
                  }}
                >
                  <option value="">{t.calendar.noService}</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {locale === "ar" ? s.name_ar || s.name : s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t.calendar.doctor}>
                <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                  <option value="">{t.calendar.noDoctor}</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label={t.common.date}>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label={t.common.time}>
                <Input type="time" value={time} step={900} onChange={(e) => setTime(e.target.value)} />
              </Field>
              <Field label={t.calendar.duration}>
                <Input
                  type="number"
                  dir="ltr"
                  min={5}
                  step={5}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value) || 30)}
                />
              </Field>
            </div>

            <Field label={t.common.notes}>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-20" />
            </Field>

            {state.mode === "edit" && (
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{t.common.status}</span>
                <div className="flex flex-wrap gap-1.5">
                  {(["scheduled", "confirmed", "completed", "no_show"] as const).map((s) => (
                    <button
                      key={s}
                      disabled={pending || state.appt.status === s}
                      onClick={() => setStatus(s)}
                      className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-default ${
                        state.appt.status === s
                          ? "ring-2 ring-brand-400"
                          : "hover:opacity-80"
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

        <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3.5">
          {state.mode === "edit" && state.appt.status !== "cancelled" ? (
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
              disabled={
                !startsAt ||
                (state.mode === "create" && !patient && !(newPatient?.fullName.trim()))
              }
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

function PatientPicker({
  slug,
  onPick,
  onCreateNew,
}: {
  slug: string;
  onPick: (p: { id: string; name: string }) => void;
  onCreateNew: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string; phone_e164: string | null }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (val: string) => {
    setQ(val);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (val.trim().length < 2) {
        setResults([]);
        return;
      }
      const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(val)}`);
      if (res.ok) setResults((await res.json()).results ?? []);
    }, 250);
  };

  return (
    <div className="grid gap-1.5">
      <Input value={q} onChange={(e) => search(e.target.value)} placeholder={t.calendar.searchOrCreate} />
      {results.map((r) => (
        <button
          key={r.id}
          onClick={() => onPick({ id: r.id, name: r.full_name })}
          className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-start text-sm hover:bg-sunken"
        >
          <Avatar name={r.full_name} size={26} />
          <span className="flex-1 font-medium">{r.full_name}</span>
          {r.phone_e164 && (
            <span dir="ltr" className="text-[12px] text-ink-400 tnum">
              {formatPhone(r.phone_e164)}
            </span>
          )}
        </button>
      ))}
      <button
        onClick={onCreateNew}
        className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-start text-sm text-brand-700 hover:border-brand-400 hover:bg-brand-50/40"
      >
        <UserPlus className="h-4 w-4" />
        {t.calendar.createNew}
      </button>
    </div>
  );
}
