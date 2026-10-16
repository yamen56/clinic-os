"use client";

import { useEffect, useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ServiceSelect } from "@/components/ui/service-picker";
import { PatientPicker } from "@/components/appointments/patient-picker";
import { walkInAction } from "../flow-actions";
import type { CalendarMeta } from "../types";
import { X } from "lucide-react";

/**
 * Somebody at the desk without an appointment. They go straight into the
 * waiting room — and onto the doctor's board, with the chime.
 */
export function WalkInModal({
  slug,
  open,
  onClose,
  onDone,
  meta,
  defaultDoctorId,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  meta: CalendarMeta | null;
  defaultDoctorId: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [newPatient, setNewPatient] = useState<{ fullName: string; phone: string } | null>(null);
  const [doctorId, setDoctorId] = useState(defaultDoctorId);
  const [serviceId, setServiceId] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setPatient(null);
    setNewPatient(null);
    setDoctorId(defaultDoctorId);
    setServiceId("");
    setNotes("");
  }, [open, defaultDoctorId]);

  const save = () =>
    start(async () => {
      const r = await walkInAction(slug, {
        patientId: patient?.id,
        newPatient: newPatient ?? undefined,
        doctorMemberId: doctorId || null,
        serviceId: serviceId || null,
        notes,
      });
      if (r.error || !r.id) {
        toast(r.error === "patient_required" ? t.common.required : t.common.genericError, "error");
        return;
      }
      toast(t.flow.walkInAdded.replace("{name}", patient?.name ?? newPatient?.fullName ?? ""));
      onDone();
    });

  return (
    <Modal open={open} onClose={onClose} title={t.flow.walkInTitle}>
      <div className="grid gap-4" data-walk-in>
        <p className="-mt-1 text-[13px] text-ink-500">{t.flow.walkInHint}</p>
        <Field label={t.calendar.patient} required>
          {patient ? (
            <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
              <Avatar name={patient.name} size={28} />
              <span className="flex-1 text-sm font-medium">{patient.name}</span>
              <button onClick={() => setPatient(null)} aria-label={t.common.delete} className="text-ink-400 hover:text-danger">
                <X className="h-4 w-4" />
              </button>
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
            <PatientPicker slug={slug} autoFocus onPick={setPatient} onCreateNew={() => setNewPatient({ fullName: "", phone: "" })} />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.calendar.doctor}>
            <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">{t.calendar.noDoctor}</option>
              {(meta?.doctors ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.calendar.service}>
            <ServiceSelect
              services={meta?.services ?? []}
              sections={meta?.sections ?? []}
              value={serviceId}
              onChange={setServiceId}
              emptyLabel={t.calendar.noService}
            />
          </Field>
        </div>
        <Field label={t.common.notes}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-16" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button loading={pending} disabled={!patient && !newPatient?.fullName.trim()} onClick={save}>
            {t.flow.arrived}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
