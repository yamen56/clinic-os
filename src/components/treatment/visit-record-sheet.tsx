"use client";

/*
  Recording a visit: what it was, and what was done at it.

  The one place the treatment record is written. It opens from the visit
  banner while the patient is in the room, from the Overview's card and from
  an appointment's row, on the same visit each time.

  Most doctors use it on a phone between patients (Yamen, 2026-10-31), so it
  rises from the bottom, every part is optional, and nothing waits for a Save
  button: the text is saved as it is typed (lib/use-autosave) and a treatment
  is recorded by the tap that picks it. What the visit was booked for is
  offered first, one tap each — the doctor confirms it rather than finding it.

  The doctor never types a price. A treatment from the price list carries the
  list's price to reception's Ready to bill; one typed by hand has none, and
  reception prices it on the invoice.

  Tooth and face work is not entered here. A clinic with a chart sees the
  visit's share of it, and a button to the chart.
*/

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, ScanFace, Search, Smile, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { fmtDate, fmtMoney, fmtTime } from "@/lib/dates";
import { useOptionalDentalStore } from "@/components/charts/dental/store";
import { useOptionalFaceStore } from "@/components/charts/face/store";
import type { GeneralMark, ServiceOption, VisitRecord } from "@/lib/treatment/db";
import { dayOf, standing } from "@/lib/treatment/visits";
import { call, newId, useOptionalTreatmentStore, type TreatmentStore } from "./store";
import { useChartWork } from "./visit-record-view";

type Field = "complaint" | "exam" | "diagnosis" | "plan";
type Answer = { label?: string; labelAr?: string; value?: unknown };

/** How long after recording a treatment its Remove is an undo rather than a void — just inside the server's two minutes. */
const UNDO_MS = 110_000;
const SHOWN = 8;

/** The sheet, wherever in the file it was asked for. Renders nothing while closed. */
export function VisitRecordSheetHost() {
  const store = useOptionalTreatmentStore();
  if (!store?.sheet || !store.canWrite) return null;
  const { appointmentId } = store.sheet;
  // A visit opened again is a new sheet: its own record, its own autosave.
  return <Sheet key={appointmentId ?? "day"} store={store} appointmentId={appointmentId} />;
}

function Sheet({ store, appointmentId }: { store: TreatmentStore; appointmentId: string | null }) {
  const { t, locale } = useI18n();
  const T = t.treatment;
  const { toast } = useToast();
  const { tz } = store;
  const dental = useOptionalDentalStore();
  const face = useOptionalFaceStore();
  const chart = useChartWork().get(appointmentId ?? "");
  const visit = appointmentId ? store.visits.find((v) => v.id === appointmentId) : undefined;
  const [today] = useState(() => dayOf(new Date().toISOString(), tz));

  // The record being written: the visit's, or today's when there is no visit. Its id is made here when there is none yet.
  const [existing] = useState<VisitRecord | undefined>(() =>
    appointmentId ? store.records.find((r) => r.appointmentId === appointmentId) : store.records.find((r) => !r.appointmentId && dayOf(r.createdAt, tz) === today)
  );
  const [recordId] = useState(() => existing?.id ?? newId());
  const [text, setText] = useState<Record<Field, string>>({
    complaint: existing?.complaint ?? "",
    exam: existing?.exam ?? "",
    diagnosis: existing?.diagnosis ?? "",
    plan: existing?.plan ?? "",
  });
  const base = `/api/c/${store.slug}/patients/${store.patientId}/treatment`;
  const { patch, state } = useAutosave({
    url: `${base}/records/${recordId}${appointmentId ? `?visit=${appointmentId}` : ""}`,
    entityKey: `visit-record:${recordId}`,
  });

  const set = (f: Field, v: string) => {
    setText((prev) => ({ ...prev, [f]: v }));
    patch({ [f]: v });
    store.mine(recordId);
    // The card behind the sheet reads the same record: it follows the typing.
    store.setRecords((prev) => {
      const now = new Date().toISOString();
      if (prev.some((r) => r.id === recordId)) return prev.map((r) => (r.id === recordId ? { ...r, [f]: v, updatedBy: store.me, updatedAt: now } : r));
      return [...prev, { id: recordId, appointmentId, complaint: "", exam: "", diagnosis: "", plan: "", [f]: v, recordedBy: store.me, updatedBy: store.me, createdAt: now, updatedAt: now }];
    });
  };

  // What was said when the visit was booked: the desk's note and the patient's answers, beside the complaint.
  const booking = appointmentId ? store.feed.find((f) => f.source === "visit" && f.id === appointmentId) : undefined;
  const said = [
    ...(booking?.body.trim() ? [booking.body.trim()] : []),
    ...(Array.isArray(booking?.extra) ? (booking!.extra as Answer[]) : [])
      .filter((a) => a.value !== undefined && a.value !== null && String(a.value).trim() !== "")
      .map((a) => `${(locale === "ar" ? a.labelAr : null) || a.label || ""}: ${Array.isArray(a.value) ? a.value.join("، ") : String(a.value)}`),
  ];

  // The patient's earlier diagnoses, newest first: a follow-up is usually for one of them.
  const earlier = useMemo(() => {
    const seen = new Set<string>();
    return [...store.records]
      .filter((r) => r.id !== recordId && r.diagnosis.trim())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((r) => r.diagnosis.trim())
      .filter((d) => (seen.has(d) ? false : (seen.add(d), true)))
      .slice(0, 4);
  }, [store.records, recordId]);

  // What is recorded as done at this visit — or, with no visit, today with none.
  const known = new Set(store.visits.map((v) => v.id));
  const done = standing(store.marks).filter((m) =>
    appointmentId ? m.appointmentId === appointmentId : (!m.appointmentId || !known.has(m.appointmentId)) && dayOf(m.doneAt ?? m.createdAt, tz) === today
  );

  // Done by the visit's doctor; with no visit, by whoever is recording when they are a doctor.
  const performer = visit?.doctor_member_id ?? (store.doctors.some((d) => d.id === store.myMemberId) ? store.myMemberId : null);

  const add = async (svc: ServiceOption | null, typed?: string) => {
    const id = newId();
    const now = new Date().toISOString();
    const doer = performer ? (store.doctors.find((d) => d.id === performer) ?? null) : null;
    const local: GeneralMark = {
      id,
      label: svc?.name ?? typed ?? "",
      labelAr: svc?.nameAr || svc?.name || typed || "",
      serviceId: svc?.id ?? null,
      fee: svc ? svc.price : null,
      status: "done",
      note: "",
      performedBy: doer,
      recordedBy: store.me,
      createdAt: now,
      doneAt: now,
      voidedAt: null,
      appointmentId,
      courseId: null,
    };
    store.setMarks((prev) => [...prev, local]);
    try {
      const r = await store.write(
        [id],
        call<{ mark: GeneralMark }>(`${base}/marks`, "POST", {
          id,
          eventId: newId(),
          serviceId: svc?.id ?? null,
          label: svc ? null : typed,
          appointmentId,
          performedBy: performer,
        })
      );
      store.setMarks((prev) => prev.map((m) => (m.id === id ? r.mark : m)));
    } catch {
      store.setMarks((prev) => prev.filter((m) => m.id !== id));
      toast(T.saveFailed, "error");
    }
  };

  const remove = async (m: GeneralMark) => {
    const url = `${base}/marks/${m.id}`;
    store.setMarks((prev) => prev.map((x) => (x.id === m.id ? { ...x, voidedAt: new Date().toISOString() } : x)));
    try {
      // A mis-tap is taken back whole; after that it is a record, and leaves by being voided.
      if (m.recordedBy.id === store.me.id && Date.now() - Date.parse(m.createdAt) < UNDO_MS) {
        try {
          await store.write([m.id], call(url, "DELETE"));
          store.setMarks((prev) => prev.filter((x) => x.id !== m.id));
          return;
        } catch (e) {
          if ((e as Error).message !== "too_late") throw e;
        }
      }
      const r = await store.write([m.id], call<{ mark: GeneralMark }>(url, "PATCH", { op: "void", eventId: newId() }));
      store.setMarks((prev) => prev.map((x) => (x.id === m.id ? r.mark : x)));
    } catch {
      store.setMarks((prev) => prev.map((x) => (x.id === m.id ? m : x)));
      toast(T.saveFailed, "error");
    }
  };

  // Offered first: what the visit was booked for and is not recorded yet.
  const nameOf = (s: { name: string; nameAr: string | null }) => (locale === "ar" && s.nameAr) || s.name;
  const booked = (visit?.service_ids ?? [])
    .map((id) => store.services.find((s) => s.id === id))
    .filter((s): s is ServiceOption => !!s && !done.some((m) => m.serviceId === s.id));

  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matches = store.services.filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.nameAr ?? "").includes(q.trim()));
  const exact = store.services.some((s) => s.name.toLowerCase() === needle || (s.nameAr ?? "") === q.trim());

  const when = visit ? `${fmtDate(visit.starts_at, tz, locale)} · ${fmtTime(visit.starts_at, tz, locale)}` : `${fmtDate(new Date().toISOString(), tz, locale)} · ${T.noVisit}`;
  const service = visit ? (locale === "ar" && visit.service_name_ar) || visit.service_name : null;
  const openChart = (key: string) => {
    store.closeSheet();
    store.goTab(key);
  };

  const area = "w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base text-ink-900 placeholder:text-ink-500 focus:border-brand-600 focus:outline-none md:text-sm";
  const heading = "mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-ink-400";
  const chip = "inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full border border-line-strong bg-surface px-4 text-start text-[14px] font-semibold text-ink-700 transition-colors duration-100 hover:bg-sunken";

  const field = (f: Field, rows: number) => (
    <label className="block">
      <span className={heading}>{T.fields[f]}</span>
      <textarea dir="auto" rows={rows} maxLength={f === "exam" ? 8000 : f === "diagnosis" ? 2000 : 4000} value={text[f]} onChange={(e) => set(f, e.target.value)} placeholder={T.placeholders[f]} className={area} data-record-input={f} />
    </label>
  );

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={T.recordTitle} data-record-sheet={appointmentId ?? "day"}>
      <button type="button" aria-label={t.common.close} onClick={store.closeSheet} className="absolute inset-0 bg-night/35 animate-fade-in" />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-2xl bg-surface shadow-pop animate-fade-up md:inset-x-auto md:bottom-auto md:left-1/2 md:top-[6vh] md:max-h-[88vh] md:w-full md:max-w-xl md:-translate-x-1/2 md:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold">{T.recordTitle}</h2>
            <p className="truncate text-[13px] text-ink-500">
              {when}
              {service ? ` · ${service}` : ""}
              {visit?.doctor_name ? ` · ${visit.doctor_name}` : ""}
            </p>
          </div>
          <button type="button" onClick={store.closeSheet} aria-label={t.common.close} className="-me-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-5 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="grid gap-2">
            {field("complaint", 2)}
            {said.length > 0 && (
              <div className="rounded-lg bg-canvas px-3 py-2 text-[12.5px] text-ink-700" data-record-booking>
                <div className="mb-0.5 font-semibold text-ink-500">{T.fromBooking}</div>
                {said.map((l, i) => (
                  <p key={i} className="whitespace-pre-wrap" dir="auto">
                    {l}
                  </p>
                ))}
              </div>
            )}
          </div>

          {field("exam", 3)}

          <div className="grid gap-2">
            {field("diagnosis", 1)}
            {!text.diagnosis.trim() && earlier.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" data-record-earlier>
                <span className="text-[12px] text-ink-500">{T.earlier}</span>
                {earlier.map((d) => (
                  <button key={d} type="button" onClick={() => set("diagnosis", d)} className="inline-flex min-h-9 max-w-full touch-manipulation items-center rounded-full border border-line bg-surface px-3 text-[13px] text-ink-700 hover:bg-sunken">
                    <span className="truncate" dir="auto">
                      {d}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <section data-record-done-edit={done.length}>
            <h3 className={heading}>{T.done}</h3>
            {done.length > 0 && (
              <ul className="mb-2 grid gap-1.5">
                {done.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-lg bg-canvas py-1 pe-1 ps-3" data-done-line={m.id}>
                    <span className="min-w-0 flex-1 text-[14px] font-medium" dir="auto">
                      {(locale === "ar" && m.labelAr) || m.label}
                    </span>
                    <span className="shrink-0 text-[12.5px] text-ink-500 tnum">{m.fee == null ? T.noPrice : fmtMoney(m.fee, store.currency, locale)}</span>
                    <button
                      type="button"
                      onClick={() => void remove(m)}
                      aria-label={`${T.remove}: ${m.label}`}
                      className="grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full text-ink-500 hover:bg-danger-soft hover:text-danger"
                      data-done-remove={m.id}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {booked.length > 0 && (
              <div className="mb-2" data-record-booked={booked.length}>
                <div className="mb-1.5 text-[12px] text-ink-500">{T.booked}</div>
                <div className="flex flex-wrap gap-2">
                  {booked.map((s) => (
                    <button key={s.id} type="button" onClick={() => void add(s)} className={chip} data-add-booked={s.id}>
                      <Plus className="h-4 w-4 shrink-0" />
                      <span dir="auto">{nameOf(s)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!picking ? (
              <button type="button" onClick={() => setPicking(true)} className={chip} data-record-pick>
                <Search className="h-4 w-4 shrink-0" />
                {T.add}
              </button>
            ) : (
              <div className="rounded-lg border border-line" data-record-picker>
                <input
                  autoFocus
                  dir="auto"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={T.search}
                  maxLength={120}
                  className="h-11 w-full rounded-t-lg border-b border-line bg-surface px-3 text-base focus:outline-none md:text-sm"
                  data-record-search
                />
                <ul className="max-h-64 overflow-y-auto">
                  {matches.slice(0, SHOWN).map((s) => (
                    <li key={s.id} className="border-b border-line last:border-b-0">
                      <button
                        type="button"
                        onClick={() => {
                          void add(s);
                          setQ("");
                        }}
                        className="flex min-h-11 w-full touch-manipulation items-center gap-3 px-3 text-start text-[14px] hover:bg-sunken"
                        data-add-service={s.id}
                      >
                        <span className="min-w-0 flex-1" dir="auto">
                          {nameOf(s)}
                        </span>
                        <span className="shrink-0 text-[12.5px] text-ink-500 tnum">{fmtMoney(s.price, store.currency, locale)}</span>
                      </button>
                    </li>
                  ))}
                  {needle && !exact && (
                    <li>
                      <button
                        type="button"
                        onClick={() => {
                          void add(null, q.trim());
                          setQ("");
                        }}
                        className="flex min-h-11 w-full touch-manipulation flex-col justify-center px-3 py-1.5 text-start hover:bg-sunken"
                        data-add-other
                      >
                        <span className="text-[14px] font-semibold text-brand-700" dir="auto">
                          {T.addOther.replace("{name}", q.trim())}
                        </span>
                        <span className="text-[12px] text-ink-500">{T.otherHint}</span>
                      </button>
                    </li>
                  )}
                  {!needle && store.services.length === 0 && <li className="px-3 py-3 text-[13px] text-ink-500">{T.noServices}</li>}
                </ul>
              </div>
            )}

            {(dental || face) && (
              <div className="mt-3 grid gap-2 rounded-lg bg-canvas p-3" data-record-charts>
                <p className="text-[12.5px] text-ink-500">{T.chartHint}</p>
                <div className="flex flex-wrap gap-2">
                  {dental && (
                    <button type="button" onClick={() => openChart("dental")} className={chip} data-open-chart="dental">
                      <Smile className="h-4 w-4 shrink-0" />
                      {T.openTooth}
                      {chart?.dental ? <span className="font-normal text-ink-500 tnum">· {T.count.replace("{n}", String(chart.dental))}</span> : null}
                    </button>
                  )}
                  {face && (
                    <button type="button" onClick={() => openChart("face")} className={chip} data-open-chart="face">
                      <ScanFace className="h-4 w-4 shrink-0" />
                      {T.openFace}
                      {chart?.face.length ? <span className="font-normal text-ink-500 tnum">· {T.count.replace("{n}", String(chart.face.length))}</span> : null}
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          {field("plan", 2)}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <span className="min-w-0 flex-1" data-record-save={state}>
            <SaveIndicator state={state} />
          </span>
          <Button size="lg" onClick={store.closeSheet} data-record-close>
            {T.close}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
