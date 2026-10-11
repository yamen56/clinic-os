"use client";

/*
  A treatment, step by step.

  The dentist asked to see the next steps of a treatment "in front of my
  face", not at the bottom of a page or in a small sheet. So a root canal, an
  implant or a crown opens here, large: every step in order, the ones done
  with when, who and at which visit, and the next one already open with what
  it records — the length of every canal, the irrigants, the implant's size —
  and one button, "Done today".

  A step done today belongs to today's visit; the server finds it. When the
  last required step is done the treatment is finished, and what usually
  comes next is offered: a crown after a root canal, the crown on an implant.
*/

import { useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Plus, Siren, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { ConfirmDialog } from "@/components/ui/modal";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { BUILT_IN_BY_KEY, findTreatment } from "@/lib/charts/dental/catalog";
import { isToothSite, paintAt, type Mark, type Person } from "@/lib/charts/dental/state";
import { tooth as toothOf, type Tooth } from "@/lib/charts/dental/teeth";
import {
  EMERGENCY_STEP,
  FOLLOW_UPS,
  canalNames,
  defaultReference,
  progressOf,
  stepSummary,
  type CanalRow,
  type ImplantRow,
  type StepData,
  type StepDef,
  type StepField,
  type StepRecord,
} from "@/lib/charts/dental/protocols";
import { implantSitesOf } from "@/lib/charts/dental/full-arch";
import { nextVisitOf, sessionKey, sessionsOf } from "@/lib/charts/dental/treatment";
import { useDentalStore } from "./store";
import { useChartWriter } from "./writer";
import { PaintPill } from "./history";
import { siteLabel } from "./labels";
import { TreatmentGlyph } from "./treatment-picker";
import { INK, SOFT } from "./tooth-art";

const UNDO_MS = 120_000;

/** A number typed the way people type it: "20.5", "21", or nothing yet. */
function Decimal({ value, onChange, label, className = "" }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string; className?: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={text}
      onChange={(e) => {
        const v = e.target.value.replace(",", ".");
        if (!/^\d{0,3}(\.\d{0,2})?$/.test(v)) return;
        setText(v);
        onChange(v === "" || v === "." ? null : Number(v));
      }}
      className={`h-9 w-full min-w-0 rounded-ctl border border-line bg-surface px-2 text-base tnum focus:border-brand-600 focus:outline-none md:text-sm ${className}`}
    />
  );
}

const field = "h-9 w-full min-w-0 rounded-ctl border border-line bg-surface px-2 text-base focus:border-brand-600 focus:outline-none md:text-sm";

/** What a step records, laid out for typing at the chair. */
function StepForm({
  def,
  mark,
  tooth,
  previous,
  implantSites,
  canWrite,
  onDone,
}: {
  def: StepDef;
  mark: Mark;
  tooth: Tooth | null;
  /** The canals as an earlier step left them: their names, and the lengths when measured. */
  previous: CanalRow[] | null;
  implantSites: string[];
  canWrite: boolean;
  onDone: (data: StepData) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const P = t.dental.treatment;
  const canalField = def.fields?.find((f): f is Extract<StepField, { kind: "canals" }> => f.kind === "canals");
  const [data, setData] = useState<StepData>(() => {
    const d: StepData = {};
    if (canalField) {
      const names = previous?.map((c) => c.name) ?? canalNames(tooth, Number(mark.detail.canals) || tooth?.roots || 1);
      d.canals = names.map((name) => ({
        name,
        ...(canalField.columns.includes("length") ? { length: null, ref: defaultReference(tooth, name) } : {}),
        ...(canalField.columns.includes("file") ? { file: "" } : {}),
      }));
    }
    if (def.fields?.some((f) => f.kind === "implants")) d.implants = implantSites.map((site) => ({ site }));
    return d;
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: StepData) => setData((d) => ({ ...d, ...patch }));
  const setCanal = (i: number, patch: Partial<CanalRow>) => set({ canals: (data.canals ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setImplant = (i: number, patch: Partial<ImplantRow>) => set({ implants: (data.implants ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const lengthOf = (name: string) => previous?.find((c) => c.name === name)?.length;

  return (
    <div className="grid gap-3 pt-2" data-step-form={def.key}>
      {def.fields?.map((f, fi) => {
        if (f.kind === "canals") {
          const cols = f.columns;
          return (
            <div key={fi} className="grid gap-1.5">
              <div className="grid items-center gap-1.5 text-[11.5px] font-semibold text-ink-500" style={{ gridTemplateColumns: `3.25rem repeat(${cols.length}, minmax(0, 1fr)) 1.75rem` }}>
                <span>{P.canal}</span>
                {cols.includes("length") && <span>{P.length}</span>}
                {cols.includes("ref") && <span>{P.reference}</span>}
                {cols.includes("file") && <span>{P.file}</span>}
                <span />
              </div>
              {(data.canals ?? []).map((c, i) => (
                <div key={i} className="grid items-center gap-1.5" style={{ gridTemplateColumns: `3.25rem repeat(${cols.length}, minmax(0, 1fr)) 1.75rem` }} data-canal={c.name}>
                  <input value={c.name} onChange={(e) => setCanal(i, { name: e.target.value.slice(0, 8) })} aria-label={P.canal} className={`${field} font-semibold`} />
                  {cols.includes("length") && <Decimal value={c.length} onChange={(v) => setCanal(i, { length: v })} label={`${c.name} ${P.length}`} />}
                  {cols.includes("ref") && <input value={c.ref ?? ""} onChange={(e) => setCanal(i, { ref: e.target.value.slice(0, 40) })} aria-label={`${c.name} ${P.reference}`} className={field} />}
                  {cols.includes("file") && (
                    <div className="relative">
                      <input value={c.file ?? ""} onChange={(e) => setCanal(i, { file: e.target.value.slice(0, 24) })} aria-label={`${c.name} ${P.file}`} placeholder="25/.06" className={field} />
                      {lengthOf(c.name) != null && <span className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-400 tnum">{lengthOf(c.name)} mm</span>}
                    </div>
                  )}
                  {(data.canals?.length ?? 0) > 1 ? (
                    <button type="button" onClick={() => set({ canals: (data.canals ?? []).filter((_, j) => j !== i) })} aria-label={t.common.delete} className="grid h-7 w-7 place-items-center rounded-md text-ink-400 hover:bg-sunken hover:text-danger">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
              {(data.canals?.length ?? 0) < 6 && (
                <button
                  type="button"
                  onClick={() => set({ canals: [...(data.canals ?? []), { name: `C${(data.canals?.length ?? 0) + 1}`, ...(cols.includes("length") ? { length: null, ref: "" } : {}), ...(cols.includes("file") ? { file: "" } : {}) }] })}
                  className="inline-flex items-center gap-1 justify-self-start text-[12.5px] font-semibold text-brand-600"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {P.addCanal}
                </button>
              )}
            </div>
          );
        }
        if (f.kind === "implants") {
          return (
            <div key={fi} className="grid gap-2">
              {(data.implants ?? []).map((im, i) => (
                <div key={im.site} className="grid gap-1.5 rounded-ctl border border-line p-2" data-implant-row={im.site}>
                  <div className="text-[12.5px] font-bold text-ink-900 tnum">
                    {P.implantSite} {im.site}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    <input value={im.system ?? ""} onChange={(e) => setImplant(i, { system: e.target.value.slice(0, 40) })} placeholder={P.implantSystem} aria-label={P.implantSystem} className={field} />
                    <Decimal value={im.diameter} onChange={(v) => setImplant(i, { diameter: v })} label={P.implantDiameter} />
                    <Decimal value={im.length} onChange={(v) => setImplant(i, { length: v })} label={P.implantLength} />
                    <Decimal value={im.torque} onChange={(v) => setImplant(i, { torque: v })} label={P.implantTorque} />
                    <input value={im.lot ?? ""} onChange={(e) => setImplant(i, { lot: e.target.value.slice(0, 40) })} placeholder={P.implantLot} aria-label={P.implantLot} className={`${field} col-span-2 sm:col-span-2`} />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] text-ink-400 sm:grid-cols-3">
                    <span>{P.implantSystem}</span>
                    <span>{P.implantDiameter}</span>
                    <span>{P.implantLength}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        }
        if (f.kind === "choice") {
          const v = data[f.key];
          const chosen = new Set(Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : []);
          return (
            <div key={fi}>
              <div className="mb-1.5 text-[12px] font-semibold text-ink-500">{f.en}</div>
              <div className="flex flex-wrap gap-1.5">
                {f.options.map((o) => {
                  const on = chosen.has(o.key);
                  return (
                    <button
                      key={o.key}
                      type="button"
                      aria-pressed={on}
                      data-choice={`${f.key}:${o.key}`}
                      onClick={() => {
                        if (f.multi) set({ [f.key]: on ? [...chosen].filter((k) => k !== o.key) : [...chosen, o.key] });
                        else set({ [f.key]: on ? undefined : o.key });
                      }}
                      className={`h-9 rounded-full border px-3 text-[13px] font-semibold transition-colors duration-140 ${
                        on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                      }`}
                    >
                      {o.en}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }
        return (
          <label key={fi} className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-500">{f.en}</span>
            <input value={(data[f.key] as string) ?? ""} onChange={(e) => set({ [f.key]: e.target.value.slice(0, 60) })} placeholder={f.placeholder} className={field} />
          </label>
        );
      })}
      {canWrite && (
        <Button
          className="h-11 w-full text-[15px]"
          loading={busy}
          data-step-done={def.key}
          onClick={async () => {
            setBusy(true);
            await onDone(data);
            setBusy(false);
          }}
        >
          <Check className="h-4.5 w-4.5" />
          {P.doneToday}
        </Button>
      )}
    </div>
  );
}

export function ProcedureCard({
  markId,
  tz,
  performer,
  backLabel,
  onBack,
  onFinish,
  onVoid,
  onNote,
  onDetail,
  onPlan,
  extra,
}: {
  markId: string;
  tz: string;
  /** Who a step done now is done by: the doctor at the chair. */
  performer: Person | null;
  backLabel: string;
  onBack: () => void;
  onFinish: (m: Mark) => void;
  onVoid: (m: Mark) => void;
  onNote: (id: string, note: string) => void;
  onDetail: (id: string, key: string, value: string) => void;
  /** Plan what usually comes next, on the same tooth. */
  onPlan: (treatmentKey: string, site: string) => void;
  extra?: string;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const P = T.treatment;
  const store = useDentalStore();
  const w = useChartWriter();
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<StepRecord | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [finishing, setFinishing] = useState(false);
  const m = store.marks.find((x) => x.id === markId);
  const steps = useMemo(() => store.steps.filter((s) => s.markId === markId), [store.steps, markId]);
  if (!m) return null;

  const tr = findTreatment(m.treatmentKey, store.custom);
  const prog = progressOf(m.treatmentKey, steps);
  const tt = isToothSite(m.site) ? toothOf(m.site) : null;
  const { sessions, emergencies } = sessionsOf(steps, tz);
  const editable = store.canWrite && !m.voidedAt;
  const planned = m.status === "planned";
  const expanded = openStep ?? (planned && editable ? (prog?.next?.key ?? null) : null);
  const live = steps.filter((s) => !s.voidedAt).sort((a, b) => Date.parse(a.doneAt) - Date.parse(b.doneAt));
  // "visit 2": the order of the visits at which this treatment's steps were done.
  const visitNo = new Map<string, number>();
  for (const s of live) {
    const k = sessionKey(s, tz);
    if (!visitNo.has(k)) visitNo.set(k, visitNo.size + 1);
  }
  const next = nextVisitOf(m.id, store.bookings, store.visits);
  const implantSites = m.treatmentKey === "implant_denture" ? implantSitesOf(m, store.marks) : isToothSite(m.site) ? [m.site] : [];
  const lastCanals = (beforeKey: string): CanalRow[] | null => {
    const idx = prog?.steps.findIndex((s) => s.key === beforeKey) ?? -1;
    for (let i = idx - 1; i >= 0; i--) {
      const rec = prog?.done.get(prog.steps[i].key)?.at(-1);
      if (rec?.data.canals?.length) return rec.data.canals;
    }
    return null;
  };
  const missing = prog ? prog.steps.filter((s) => !s.optional && !prog.done.has(s.key)) : [];
  const urgent = live.filter((s) => s.step === EMERGENCY_STEP);
  const followUps = (FOLLOW_UPS[m.treatmentKey] ?? [])
    .map((k) => BUILT_IN_BY_KEY.get(k))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .filter((x) => !store.marks.some((o) => !o.voidedAt && o.site === m.site && o.treatmentKey === x.key));
  const details = tr?.details?.filter((d) => !(d.key === "implants" && m.groupId)) ?? [];

  const done = (def: StepDef) => async (data: StepData) => {
    const ok = await w.recordStep(m, def.key, data, { performer });
    if (ok) setOpenStep(null);
    return ok;
  };

  return (
    <div className="flex flex-col gap-4" data-procedure={m.id} data-procedure-status={m.status}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={onBack} className="inline-flex h-9 shrink-0 items-center gap-1 rounded-ctl px-2 text-[13px] font-semibold text-ink-500 hover:bg-sunken">
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </button>
      </div>

      <div className="flex items-start gap-3">
        {tr && <TreatmentGlyph tr={tr} paint={paintAt(m, null) ?? "existing"} context={tt} size={52} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid h-8 min-w-8 place-items-center rounded-lg bg-brand-600 px-1.5 font-display text-[15px] font-bold text-white tnum">
              {isToothSite(m.site) ? m.site : siteLabel(m.site, T).split(" ")[0]}
            </span>
            <span className="text-[16px] font-semibold leading-tight text-ink-900">{locale === "ar" ? m.labelAr : m.label}</span>
            <PaintPill m={m} />
          </div>
          <div className="mt-1 text-[12.5px] text-ink-500">
            {[tt ? null : siteLabel(m.site, T), extra, m.performedBy?.name].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>

      {details.length > 0 && (
        <div className="grid gap-2">
          {details.map((d) => (
            <div key={d.key} className="flex flex-wrap items-center gap-1.5">
              <span className="me-1 text-[12px] font-semibold text-ink-500">{T.details[d.key]}</span>
              {d.options.map((o) => {
                const on = m.detail[d.key] === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    disabled={!editable}
                    onClick={() => onDetail(m.id, d.key, o.key)}
                    className={`h-8 rounded-full border px-3 text-[12.5px] font-semibold transition-colors duration-140 disabled:opacity-60 ${
                      on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                    }`}
                  >
                    {locale === "ar" ? o.ar : o.en}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {prog && (
        <div>
          <div className="flex gap-1" aria-hidden>
            {prog.steps
              .filter((s) => !s.optional)
              .map((s) => (
                <span key={s.key} className="h-1.5 flex-1 rounded-full" style={{ background: prog.done.has(s.key) ? INK[m.status === "done" ? "done" : "progress"] : "var(--color-line)" }} />
              ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-500" data-progress={`${prog.requiredDone}/${prog.required}`}>
            <span className="font-semibold text-ink-700">
              {m.status === "done" ? P.finished.replace("{date}", fmtDate(m.doneAt ?? m.createdAt, tz, locale)) : P.progress.replace("{done}", String(prog.requiredDone)).replace("{total}", String(prog.required))}
            </span>
            <span data-sessions={sessions}>
              {sessions === 1 ? P.session : P.sessions.replace("{n}", String(sessions))}
              {emergencies > 0 ? ` ${P.emergencies.replace("{n}", String(emergencies))}` : ""}
            </span>
          </div>
        </div>
      )}

      {/* The steps, in order. */}
      {prog && (
        <ol className="grid gap-1.5">
          {prog.steps.map((def, i) => {
            const recs = prog.done.get(def.key) ?? [];
            const isDone = recs.length > 0;
            const isNext = planned && prog.next?.key === def.key;
            const isOpen = expanded === def.key;
            return (
              <li
                key={def.key}
                className={`rounded-card border ${isOpen ? "border-brand-200 bg-brand-50/40" : "border-line bg-surface"} px-3 py-2.5`}
                data-step={def.key}
                data-step-state={isDone ? "done" : isNext ? "next" : "todo"}
              >
                <button
                  type="button"
                  disabled={!editable || (isDone && !def.repeatable)}
                  onClick={() => setOpenStep(isOpen ? "" : def.key)}
                  className="flex w-full items-start gap-3 text-start disabled:cursor-default"
                >
                  <span
                    className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-bold"
                    style={
                      isDone
                        ? { background: INK.done, color: "white" }
                        : isNext
                          ? { background: SOFT.progress, color: INK.progress, boxShadow: `inset 0 0 0 2px ${INK.progress}` }
                          : { background: "var(--color-sunken)", color: "var(--color-ink-400)" }
                    }
                  >
                    {isDone ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 text-[14px] font-semibold text-ink-900">
                      {def.en}
                      {def.optional && <span className="text-[11.5px] font-medium text-ink-400">{P.optional}</span>}
                      {def.repeatable && recs.length > 1 && <span className="text-[12px] font-semibold text-ink-500">{P.times.replace("{n}", String(recs.length))}</span>}
                      {isNext && <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: SOFT.progress, color: INK.progress }}>{P.nextBadge}</span>}
                    </span>
                    {recs.map((r) => (
                      <span key={r.id} className="mt-0.5 block text-[12px] text-ink-500">
                        {[
                          fmtDate(r.doneAt, tz, locale),
                          r.performedBy?.name ?? r.recordedBy.name,
                          visitNo.has(sessionKey(r, tz)) ? `${P.atVisit.replace("{n}", String(visitNo.get(sessionKey(r, tz))))}${r.appointmentId ? "" : ` (${P.walkIn})`}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        {stepSummary(def, r.data) && <span className="block text-[12.5px] font-medium text-ink-700" data-step-summary>{stepSummary(def, r.data)}</span>}
                      </span>
                    ))}
                  </span>
                  {editable && (!isDone || def.repeatable) && <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-ink-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />}
                </button>
                {/* A step's records can be taken back: undone just after, voided with a reason later. */}
                {editable && recs.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-3 ps-9">
                    {recs.map((r) =>
                      r.recordedBy.id === store.me.id && Date.now() - Date.parse(r.doneAt) < UNDO_MS ? (
                        <button key={r.id} type="button" onClick={() => void w.withdrawStep(r, { undo: true })} className="text-[12px] font-semibold text-brand-600 hover:underline" data-step-undo={def.key}>
                          {P.stepUndo}
                        </button>
                      ) : (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => {
                            setVoidReason("");
                            setVoiding(r);
                          }}
                          className="text-[12px] font-semibold text-ink-400 hover:text-danger"
                        >
                          {P.stepVoid}
                        </button>
                      )
                    )}
                  </div>
                )}
                {isOpen && editable && (
                  <StepForm
                    // A new canal count is a new set of canals to fill in.
                    key={`${def.key}-${recs.length}-${m.detail.canals ?? ""}`}
                    def={def}
                    mark={m}
                    tooth={tt}
                    previous={lastCanals(def.key)}
                    implantSites={implantSites}
                    canWrite={editable}
                    onDone={done(def)}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* Emergency visits in the middle of it: visits of their own, the plan unchanged. */}
      {urgent.length > 0 && (
        <ul className="grid gap-1.5">
          {urgent.map((r) => (
            <li key={r.id} className="flex items-start gap-2.5 rounded-card border border-line bg-surface px-3 py-2.5" data-emergency-step>
              <Siren className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <span className="min-w-0 flex-1 text-[13px]">
                <span className="font-semibold text-ink-900">{P.emergency}</span>
                <span className="text-ink-500"> · {fmtDateTime(r.doneAt, tz, locale)} · {r.performedBy?.name ?? r.recordedBy.name}</span>
                <span className="block text-[12.5px] text-ink-700">
                  {[r.data.complaint, ...((r.data.done as string[] | undefined) ?? []).map((k) => (P.emergencyActions as Record<string, string>)[k] ?? k)].filter(Boolean).join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Where it goes from here. */}
      <div className="grid gap-2 rounded-card bg-canvas px-3 py-3 text-[13px]">
        {planned && (
          <div className="flex flex-wrap items-center justify-between gap-2" data-next-visit={next?.id ?? ""}>
            <span className="text-ink-700">
              {next ? (
                <>
                  <span className="font-semibold text-ink-900">{P.nextVisit}</span> · {fmtDateTime(next.startsAt, tz, locale)}
                  {next.doctor ? ` · ${next.doctor}` : ""}
                </>
              ) : (
                P.notBooked
              )}
            </span>
            {!next && store.canBook && (
              <a href={`/c/${store.slug}/calendar?patient=${store.patientId}&items=${m.id}`} className={buttonClass({ variant: "outline", size: "sm" })} data-book-next>
                {P.bookNext}
              </a>
            )}
          </div>
        )}
        {m.status === "done" && followUps.length > 0 && editable && isToothSite(m.site) && (
          <div className="flex flex-wrap items-center gap-2" data-follow-ups>
            <span className="text-[12px] font-semibold text-ink-500">{P.followUp}</span>
            {followUps.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => onPlan(f.key, m.site)}
                className="h-8 rounded-full border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken"
                data-follow-up={f.key}
              >
                {P.planIt.replace("{name}", f.en)}
              </button>
            ))}
          </div>
        )}
        {editable && (
          <div className="flex flex-wrap gap-2">
            {planned && (
              <Button variant="outline" size="sm" onClick={() => store.setEmergency({ markId: m.id, site: m.site })} data-emergency-item>
                <Siren className="h-4 w-4" />
                {P.emergencyOn}
              </Button>
            )}
            {planned && prog && !prog.complete && (
              <Button variant="outline" size="sm" onClick={() => setFinishing(true)} data-finish-now>
                {P.finishNow}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="ms-auto text-danger" onClick={() => onVoid(m)}>
              {T.void}
            </Button>
          </div>
        )}
      </div>

      <label className="block">
        <span className="mb-1 block text-[12px] font-semibold text-ink-500">{T.note}</span>
        <textarea
          disabled={!editable}
          defaultValue={m.note}
          placeholder={T.notePlaceholder}
          rows={2}
          onBlur={(e) => e.target.value !== m.note && onNote(m.id, e.target.value)}
          className="w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base disabled:bg-subtle md:text-sm"
        />
      </label>

      <ConfirmDialog
        open={!!voiding}
        onClose={() => setVoiding(null)}
        onConfirm={async () => {
          if (!voiding || !voidReason.trim()) return;
          const r = voiding;
          setVoiding(null);
          await w.withdrawStep(r, { reason: voidReason.trim() });
        }}
        title={P.stepVoidTitle}
        body={P.stepVoidBody}
        confirmLabel={P.stepVoid}
        cancelLabel={T.cancel}
      >
        <input autoFocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={T.voidReason} className="h-10 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm" maxLength={300} />
      </ConfirmDialog>

      <ConfirmDialog
        open={finishing}
        onClose={() => setFinishing(false)}
        onConfirm={() => {
          setFinishing(false);
          onFinish(m);
        }}
        title={P.finishTitle}
        body={P.finishBody.replace("{list}", missing.map((s) => s.en).join(", "))}
        confirmLabel={P.finishNow}
        cancelLabel={T.cancel}
        danger={false}
      />
    </div>
  );
}
