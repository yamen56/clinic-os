"use client";

/*
  The patient's medical history, on the Overview.

  Kept once for the patient: the conditions that change how a dentist treats
  (blood thinners, a heart condition, pregnancy…), allergies, medications and
  a note. Its alerts head the whole file; here it is read in full and edited.
  Reception often takes it at the desk, so anyone who may open the file may
  change it, and every change is recorded with who made it.

  It lived in the Treatment tab's case header until that tab was taken out
  (2026-10-12); the data is the same `patients.medical_history`.
*/

import { useState } from "react";
import { Check, HeartPulse, Pencil } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { fmtDate } from "@/lib/dates";
import { COMMON_ALLERGIES, CONDITIONS, hasHistory, medicalAlerts, type MedicalHistory } from "@/lib/medical-history";
import { useOptionalDentalStore } from "./store";
import { useChartWriter } from "./writer";

const area = "w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base focus:border-brand-600 focus:outline-none md:text-sm";

function MedicalEditor({ open, onClose, value, tz }: { open: boolean; onClose: () => void; value: MedicalHistory; tz: string }) {
  const { t, locale } = useI18n();
  const M = t.patients.medical;
  const w = useChartWriter();
  const [h, setH] = useState<MedicalHistory>(value);
  const [busy, setBusy] = useState(false);
  const toggle = (k: string) => setH((x) => ({ ...x, conditions: x.conditions.includes(k) ? x.conditions.filter((c) => c !== k) : [...x.conditions, k] }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={M.title}
      wide
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            loading={busy}
            data-save-medical
            onClick={async () => {
              setBusy(true);
              const ok = await w.saveMedical(h);
              setBusy(false);
              if (ok) onClose();
            }}
          >
            {M.save}
          </Button>
        </>
      }
    >
      <div className="grid gap-4" data-medical-editor>
        <div>
          <span className="mb-1.5 block text-[12px] font-semibold text-ink-500">{M.conditions}</span>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {CONDITIONS.map((c) => {
              const on = h.conditions.includes(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  data-condition={c.key}
                  onClick={() => toggle(c.key)}
                  className={`flex h-10 items-center gap-2 rounded-ctl border px-3 text-start text-[13px] font-semibold transition-colors duration-140 ${
                    on ? (c.alert ? "border-danger bg-danger-soft text-danger" : "border-brand-600 bg-brand-50 text-brand-700") : "border-line bg-surface text-ink-700 hover:bg-sunken"
                  }`}
                >
                  {on && <Check className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{locale === "ar" ? c.ar : c.en}</span>
                </button>
              );
            })}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{M.allergies}</span>
          <input dir="auto" value={h.allergies} onChange={(e) => setH({ ...h, allergies: e.target.value.slice(0, 300) })} placeholder={M.allergiesPlaceholder} className={`${area} h-10 py-0`} data-allergies />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {COMMON_ALLERGIES.filter((a) => !h.allergies.toLowerCase().includes(a.toLowerCase())).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setH({ ...h, allergies: h.allergies.trim() ? `${h.allergies.trim()}, ${a}` : a })}
                className="h-7 rounded-full border border-line px-2.5 text-[12px] font-semibold text-ink-700 hover:bg-sunken"
                dir="ltr"
              >
                + {a}
              </button>
            ))}
          </div>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{M.medications}</span>
          <textarea dir="auto" rows={2} value={h.medications} onChange={(e) => setH({ ...h, medications: e.target.value.slice(0, 1000) })} placeholder={M.medicationsPlaceholder} className={area} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{M.notes}</span>
          <textarea dir="auto" rows={2} value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value.slice(0, 2000) })} className={area} />
        </label>
        {value.updatedAt && (
          <p className="text-[12px] text-ink-500">{M.updatedBy.replace("{date}", fmtDate(value.updatedAt, tz, locale)).replace("{name}", value.updatedBy ?? "")}</p>
        )}
      </div>
    </Modal>
  );
}

/** The medical history card: nothing without the dental chart, which holds it. */
export function MedicalCard({ tz }: { tz: string }) {
  const store = useOptionalDentalStore();
  if (!store) return null;
  return <MedicalCardBody tz={tz} />;
}

function MedicalCardBody({ tz }: { tz: string }) {
  const { t, locale } = useI18n();
  const M = t.patients.medical;
  const store = useOptionalDentalStore()!;
  const [open, setOpen] = useState(false);
  const h = store.medical;
  const alerts = medicalAlerts(h, locale);
  const others = CONDITIONS.filter((c) => !c.alert && h.conditions.includes(c.key)).map((c) => (locale === "ar" ? c.ar : c.en));
  return (
    <div data-medical-card>
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            <HeartPulse className="h-4 w-4 text-danger" />
            {M.title}
          </h3>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-edit-medical>
            <Pencil className="h-3.5 w-3.5" />
            {M.edit}
          </Button>
        </div>
        {hasHistory(h) ? (
          <div className="grid gap-2 text-[13px]">
            {alerts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {alerts.map((a) => (
                  <span key={a} className="rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-semibold text-danger" data-medical-alert>
                    {a}
                  </span>
                ))}
              </div>
            )}
            {others.length > 0 && (
              <p>
                <span className="text-ink-500">{M.conditions}: </span>
                {others.join(locale === "ar" ? "، " : ", ")}
              </p>
            )}
            {h.medications.trim() && (
              <p dir="auto">
                <span className="text-ink-500">{M.medications}: </span>
                {h.medications}
              </p>
            )}
            {h.notes.trim() && (
              <p className="whitespace-pre-wrap" dir="auto">
                {h.notes}
              </p>
            )}
            {h.updatedAt && <p className="text-[12px] text-ink-400">{M.updatedBy.replace("{date}", fmtDate(h.updatedAt, tz, locale)).replace("{name}", h.updatedBy ?? "")}</p>}
          </div>
        ) : (
          <p className="text-[13px] text-ink-500">{M.none}</p>
        )}
      </Card>
      <MedicalEditor key={h.updatedAt ?? "none"} open={open} onClose={() => setOpen(false)} value={h} tz={tz} />
    </div>
  );
}
