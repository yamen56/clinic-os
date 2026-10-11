"use client";

/*
  The case at the top of the Treatment tab: one problem and what is done
  about it.

  What the dentist asked for with every new problem: the history, the
  diagnosis, and the plan. The complaint and the diagnosis are always in view
  — they are what the plan below answers — and the history and examination
  open beneath them. Everything saves as it is typed, like the rest of the
  file. A new problem later is a new case, with its own history, diagnosis and
  plan; the earlier ones stay as they were.

  The medical history is the patient's, not the case's: kept once, shown here
  with its alerts, and confirmed again for each case.
*/

import { useState } from "react";
import { AlertTriangle, Check, Pill, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { fmtDate } from "@/lib/dates";
import { caseName, type TreatmentCase } from "@/lib/charts/dental/treatment";
import { COMMON_ALLERGIES, CONDITIONS, hasHistory, medicalAlerts, type MedicalHistory } from "@/lib/medical-history";
import { useDentalStore } from "./store";
import { useChartWriter } from "./writer";

const QUICK_DIAGNOSES = [
  "Reversible pulpitis",
  "Symptomatic irreversible pulpitis",
  "Pulp necrosis",
  "Symptomatic apical periodontitis",
  "Acute apical abscess",
  "Chronic apical abscess",
  "Cracked tooth",
  "Gingivitis",
  "Periodontitis",
  "Pericoronitis",
  "Partially edentulous",
  "Edentulous",
];

const area = "w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base focus:border-brand-600 focus:outline-none md:text-sm";

function MedicalEditor({ open, onClose, value, tz }: { open: boolean; onClose: () => void; value: MedicalHistory; tz: string }) {
  const { t, locale } = useI18n();
  const P = t.dental.treatment;
  const w = useChartWriter();
  const [h, setH] = useState<MedicalHistory>(value);
  const [busy, setBusy] = useState(false);
  const toggle = (k: string) => setH((x) => ({ ...x, conditions: x.conditions.includes(k) ? x.conditions.filter((c) => c !== k) : [...x.conditions, k] }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={P.medical}
      wide
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t.dental.cancel}
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
            {P.medicalSave}
          </Button>
        </>
      }
    >
      <div className="grid gap-4" data-medical-editor>
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
                <span className="truncate">{c.en}</span>
              </button>
            );
          })}
        </div>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.allergies}</span>
          <input dir="auto" value={h.allergies} onChange={(e) => setH({ ...h, allergies: e.target.value.slice(0, 300) })} placeholder={P.allergiesPlaceholder} className={`${area} h-10 py-0`} data-allergies />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {COMMON_ALLERGIES.filter((a) => !h.allergies.toLowerCase().includes(a.toLowerCase())).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setH({ ...h, allergies: h.allergies.trim() ? `${h.allergies.trim()}, ${a}` : a })}
                className="h-7 rounded-full border border-line px-2.5 text-[12px] font-semibold text-ink-700 hover:bg-sunken"
              >
                + {a}
              </button>
            ))}
          </div>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.medications}</span>
          <textarea dir="auto" rows={2} value={h.medications} onChange={(e) => setH({ ...h, medications: e.target.value.slice(0, 1000) })} placeholder={P.medicationsPlaceholder} className={area} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.notes}</span>
          <textarea dir="auto" rows={2} value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value.slice(0, 2000) })} className={area} />
        </label>
        {value.updatedAt && (
          <p className="text-[12px] text-ink-500">{P.updatedBy.replace("{date}", fmtDate(value.updatedAt, tz, locale)).replace("{name}", value.updatedBy ?? "")}</p>
        )}
      </div>
    </Modal>
  );
}

/** The case's own fields, saved as they are typed. Keyed by case, so switching cases starts clean. */
function CaseFields({ c, tz, onPrescribe }: { c: TreatmentCase; tz: string; onPrescribe?: (diagnosis: string) => void }) {
  const { t, locale } = useI18n();
  const P = t.dental.treatment;
  const store = useDentalStore();
  const editable = store.canWrite;
  const { patch, state } = useAutosave({ url: `/api/c/${store.slug}/patients/${store.patientId}/cases/${c.id}`, entityKey: `case:${c.id}` });
  const [f, setF] = useState({ complaint: c.complaint, history: c.history, exam: c.exam, diagnosis: c.diagnosis });
  const [more, setMore] = useState(!!(c.history || c.exam));
  const [medicalOpen, setMedicalOpen] = useState(false);
  /*
    Folded to two lines once the complaint and the diagnosis are written: the
    plan and the chart below are what the doctor came to the tab for, and a
    form already filled in should not push them off the screen.
  */
  const [open, setOpen] = useState(() => !c.complaint.trim() || !c.diagnosis.trim());
  /*
    The usual diagnoses, one tap each: open on a case still to be diagnosed,
    and by a button after. Never hidden by the box losing focus — that moved
    everything under it as the doctor reached for the next button.
  */
  const [chips, setChips] = useState(() => !c.diagnosis.trim());
  const set = (fields: Partial<typeof f>) => {
    setF((x) => ({ ...x, ...fields }));
    store.setCases((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...fields } : x)));
    patch(fields);
  };
  const setCase = (fields: Partial<TreatmentCase>, wire: Record<string, unknown>) => {
    store.setCases((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...fields } : x)));
    patch(wire);
  };
  const alerts = medicalAlerts(store.medical, "en");
  const reviewed = c.medicalReviewedAt;
  const confirm = editable && !reviewed && (
    <Button
      variant="outline"
      size="sm"
      data-confirm-medical
      onClick={() => setCase({ medicalReviewedAt: new Date().toISOString(), medicalReviewedBy: store.me }, { medical_reviewed: true })}
    >
      {P.medicalConfirm}
    </Button>
  );

  if (!open) {
    return (
      <div className="grid gap-2" data-case-summary>
        <button type="button" onClick={() => setOpen(true)} className="-mx-1 grid gap-0.5 rounded-ctl px-1 py-0.5 text-start hover:bg-canvas" data-case-expand>
          {f.diagnosis.trim() && (
            <span className="text-[14px] font-semibold leading-snug text-ink-900" dir="auto">
              <span className="font-medium text-ink-500">{P.diagnosis} · </span>
              {f.diagnosis}
            </span>
          )}
          {f.complaint.trim() && (
            <span className="line-clamp-1 text-[13px] text-ink-700" dir="auto">
              <span className="text-ink-500">{P.complaint} · </span>
              {f.complaint}
            </span>
          )}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {alerts.map((a) => (
            <span key={a} className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-semibold text-danger" data-medical-alert>
              <AlertTriangle className="h-3 w-3" />
              {a}
            </span>
          ))}
          {confirm}
          <SaveIndicator state={state} />
          <span className="ms-auto flex flex-wrap gap-2">
            {onPrescribe && (
              <Button variant="soft" size="sm" onClick={() => onPrescribe(f.diagnosis)} data-case-rx>
                <Pill className="h-4 w-4" />
                {P.prescription}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              {P.details}
            </Button>
          </span>
        </div>
        <MedicalEditor key={store.medical.updatedAt ?? "none"} open={medicalOpen} onClose={() => setMedicalOpen(false)} value={store.medical} tz={tz} />
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.complaint}</span>
          <textarea dir="auto" rows={2} readOnly={!editable} value={f.complaint} onChange={(e) => set({ complaint: e.target.value.slice(0, 2000) })} placeholder={P.complaintPlaceholder} className={area} data-case-field="complaint" />
        </label>
        <div>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.diagnosis}</span>
            <textarea
              dir="auto"
              rows={2}
              readOnly={!editable}
              value={f.diagnosis}
              onChange={(e) => set({ diagnosis: e.target.value.slice(0, 4000) })}
              placeholder={P.diagnosisPlaceholder}
              className={area}
              data-case-field="diagnosis"
            />
          </label>
          {editable && !chips && (
            <button type="button" onClick={() => setChips(true)} className="mt-1 text-[12px] font-semibold text-brand-600 hover:underline" data-quick-dx>
              + {P.quickDiagnoses}
            </button>
          )}
          {editable && chips && (
            <div className="mt-1.5 flex flex-wrap gap-1" aria-label={P.quickDiagnoses}>
              {QUICK_DIAGNOSES.filter((d) => !f.diagnosis.includes(d)).slice(0, 8).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => set({ diagnosis: f.diagnosis.trim() ? `${f.diagnosis.trim()}; ${d}` : d })}
                  className="h-7 rounded-full border border-line px-2.5 text-[11.5px] font-semibold text-ink-600 hover:bg-sunken"
                >
                  + {d}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {more ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.history}</span>
            <textarea dir="auto" rows={3} readOnly={!editable} value={f.history} onChange={(e) => set({ history: e.target.value.slice(0, 8000) })} placeholder={P.historyPlaceholder} className={area} data-case-field="history" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.exam}</span>
            <textarea dir="auto" rows={3} readOnly={!editable} value={f.exam} onChange={(e) => set({ exam: e.target.value.slice(0, 8000) })} placeholder={P.examPlaceholder} className={area} data-case-field="exam" />
          </label>
        </div>
      ) : (
        <button type="button" onClick={() => setMore(true)} className="justify-self-start text-[12.5px] font-semibold text-brand-600 hover:underline" data-case-more>
          + {P.history} · {P.exam}
        </button>
      )}

      {/* The patient's medical history: once for the patient, looked at again for this case. */}
      <div className="flex flex-wrap items-center gap-2 rounded-ctl bg-canvas px-3 py-2" data-medical-row>
        <span className="text-[12px] font-semibold text-ink-500">{P.medical}</span>
        {alerts.length > 0 ? (
          alerts.map((a) => (
            <span key={a} className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-semibold text-danger" data-medical-alert>
              <AlertTriangle className="h-3 w-3" />
              {a}
            </span>
          ))
        ) : (
          <span className="text-[12.5px] text-ink-500">{hasHistory(store.medical) ? CONDITIONS.filter((x) => store.medical.conditions.includes(x.key)).map((x) => x.en).join(", ") || store.medical.medications : P.medicalNone}</span>
        )}
        <button type="button" onClick={() => setMedicalOpen(true)} className="text-[12.5px] font-semibold text-brand-600 hover:underline" data-edit-medical>
          {P.medicalEdit}
        </button>
        <span className="ms-auto flex items-center gap-2">
          {reviewed ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-ink-500" data-medical-reviewed>
              <Check className="h-3.5 w-3.5 text-st-confirmed" />
              {P.medicalReviewed.replace("{date}", fmtDate(reviewed, tz, locale)).replace("{name}", c.medicalReviewedBy?.name ?? "")}
            </span>
          ) : (
            editable && (
              <Button
                variant="outline"
                size="sm"
                data-confirm-medical
                onClick={() => setCase({ medicalReviewedAt: new Date().toISOString(), medicalReviewedBy: store.me }, { medical_reviewed: true })}
              >
                {P.medicalConfirm}
              </Button>
            )
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-ink-500">
        <label className="flex items-center gap-2">
          <span className="font-semibold">{P.doctor}</span>
          <select
            disabled={!editable}
            value={c.doctor?.id ?? ""}
            onChange={(e) => {
              const d = store.doctors.find((x) => x.id === e.target.value) ?? null;
              setCase({ doctor: d }, { doctor_member_id: d?.id ?? null });
            }}
            className="select-chevron h-8 appearance-none rounded-ctl border border-line bg-surface ps-2.5 pe-8 text-base disabled:bg-subtle md:text-sm"
          >
            <option value="">{P.noDoctor}</option>
            {store.doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <span>{P.opened.replace("{date}", fmtDate(c.createdAt, tz, locale)).replace("{name}", c.createdBy.name)}</span>
        {c.status === "closed" && c.closedAt && <span>{P.closed.replace("{date}", fmtDate(c.closedAt, tz, locale))}</span>}
        <SaveIndicator state={state} />
        <span className="ms-auto flex flex-wrap gap-2">
          {onPrescribe && (
            <Button variant="soft" size="sm" onClick={() => onPrescribe(f.diagnosis)} data-case-rx>
              <Pill className="h-4 w-4" />
              {P.prescription}
            </Button>
          )}
          {f.complaint.trim() && f.diagnosis.trim() && (
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} data-case-fold>
              {P.less}
            </Button>
          )}
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              data-case-status
              onClick={() =>
                c.status === "open"
                  ? setCase({ status: "closed", closedAt: new Date().toISOString() }, { status: "closed" })
                  : setCase({ status: "open", closedAt: null }, { status: "open" })
              }
            >
              {c.status === "open" ? P.closeCase : P.reopen}
            </Button>
          )}
        </span>
      </div>

      <MedicalEditor key={store.medical.updatedAt ?? "none"} open={medicalOpen} onClose={() => setMedicalOpen(false)} value={store.medical} tz={tz} />
    </div>
  );
}

/** The form that opens a case: what brought the patient in, and the doctor it is with. */
function StartCase({ onStarted, onCancel }: { onStarted: (c: TreatmentCase) => void; onCancel?: () => void }) {
  const { t } = useI18n();
  const P = t.dental.treatment;
  const store = useDentalStore();
  const w = useChartWriter();
  const [complaint, setComplaint] = useState("");
  const [doctor, setDoctor] = useState(() => store.doctors.find((d) => d.id === store.myMemberId)?.id ?? store.doctors[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-3" data-start-case>
      <div>
        <h3 className="font-display text-base font-semibold text-ink-900">{P.startTitle}</h3>
        <p className="mt-0.5 text-[13px] text-ink-500">{P.startHint}</p>
      </div>
      <textarea dir="auto" autoFocus rows={2} value={complaint} onChange={(e) => setComplaint(e.target.value.slice(0, 2000))} placeholder={P.complaintPlaceholder} className={area} data-start-complaint />
      <div className="flex flex-wrap items-center gap-2">
        <select value={doctor} onChange={(e) => setDoctor(e.target.value)} className="select-chevron h-9 appearance-none rounded-ctl border border-line bg-surface ps-3 pe-8 text-base md:text-sm" aria-label={P.doctor}>
          <option value="">{P.noDoctor}</option>
          {store.doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <Button
          loading={busy}
          data-start-case-go
          onClick={async () => {
            setBusy(true);
            const c = await w.openCase({ complaint: complaint.trim(), doctorMemberId: doctor || null });
            setBusy(false);
            if (c) onStarted(c);
          }}
        >
          {P.start}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t.dental.cancel}
          </Button>
        )}
      </div>
    </div>
  );
}

export function CaseHeader({ tz, onPrescribe }: { tz: string; onPrescribe?: (diagnosis: string) => void }) {
  const { t, locale } = useI18n();
  const P = t.dental.treatment;
  const store = useDentalStore();
  const { cases, activeCaseId, setActiveCaseId, canWrite } = store;
  const [starting, setStarting] = useState(false);
  const active = cases.find((c) => c.id === activeCaseId) ?? null;
  const open = cases.filter((c) => c.status === "open");
  const closed = cases.filter((c) => c.status === "closed");
  const started = (c: TreatmentCase) => {
    setActiveCaseId(c.id);
    setStarting(false);
  };

  if (!cases.length || starting) {
    return (
      // The hooks sit on a wrapper: Card passes on no data-* attribute.
      <div className="min-w-0" data-case-header>
        <Card className="p-4">
          {canWrite ? <StartCase onStarted={started} onCancel={cases.length ? () => setStarting(false) : undefined} /> : <p className="text-[13px] text-ink-500">{P.noCase}</p>}
        </Card>
      </div>
    );
  }

  return (
    <div className="min-w-0" data-case-header data-active-case={active?.id ?? ""}>
    <Card className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {open.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={c.id === activeCaseId}
            onClick={() => setActiveCaseId(c.id)}
            className={`inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-full border px-3 text-[13px] font-semibold transition-colors duration-140 ${
              c.id === activeCaseId ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
            }`}
            data-case-chip={c.id}
          >
            <span className="truncate">{caseName(c) || fmtDate(c.createdAt, tz, locale)}</span>
          </button>
        ))}
        {closed.length > 0 && (
          <select
            value={closed.some((c) => c.id === activeCaseId) ? (activeCaseId ?? "") : ""}
            onChange={(e) => e.target.value && setActiveCaseId(e.target.value)}
            className="select-chevron h-9 appearance-none rounded-full border border-line bg-surface ps-3 pe-8 text-[13px] font-semibold text-ink-700"
            aria-label={P.previous}
          >
            <option value="">{`${P.previous} (${closed.length})`}</option>
            {closed.map((c) => (
              <option key={c.id} value={c.id}>
                {`${caseName(c) || P.caseOf.replace("{name}", "")} · ${fmtDate(c.createdAt, tz, locale)}`}
              </option>
            ))}
          </select>
        )}
        {canWrite && (
          <Button variant="ghost" size="sm" onClick={() => setStarting(true)} data-new-case>
            <Plus className="h-4 w-4" />
            {P.newCase}
          </Button>
        )}
      </div>
      {active ? <CaseFields key={active.id} c={active} tz={tz} onPrescribe={onPrescribe} /> : <p className="text-[13px] text-ink-500">{P.before}</p>}
    </Card>
    </div>
  );
}
