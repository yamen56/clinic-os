"use client";

/*
  Recording a visit: what it was, and what was done at it.

  The one place the treatment record is written. It opens from the visit
  banner while the patient is in the room, from the Overview's card and from
  an appointment's row, on the same visit each time.

  Most doctors use it on a phone between patients (Yamen, 2026-10-31), so it
  rises from the bottom, every part is optional, and nothing waits for a Save
  button: the text is saved as it is typed (lib/use-autosave) and a treatment
  is recorded by the tap that picks it. What the visit was booked for, and
  what an earlier visit planned, is offered first, one tap each — the doctor
  confirms it rather than finding it.

  Or says it (2026-11-15, "a talk mode"): with Talk on, one microphone fills
  the record, and saying a section's name moves to it (./use-dictation).

  Everything the visit produces is reached from here and filed under it
  (2026-11-15, "they should be connected"): a prescription starts from the
  visit's diagnosis and comes back to this sheet, a file or a photo is added
  to the visit, and a treatment planned for later waits on the patient's
  record until a visit marks it done.

  The doctor never types a price. A treatment from the price list carries the
  list's price to reception's Ready to bill; one typed by hand has none, and
  reception prices it on the invoice.

  Tooth and face work is not entered here. A clinic with a chart sees the
  visit's share of it, and a button to the chart — which offers the way back.
*/

import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileText, Mic, Paperclip, Pill, Plus, ScanFace, Square, X } from "lucide-react";
import { Tooth } from "@/components/ui/tooth-icon";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { fmtDate, fmtMoney, fmtTime } from "@/lib/dates";
import { useOptionalDentalStore } from "@/components/charts/dental/store";
import { useOptionalFaceStore } from "@/components/charts/face/store";
import type { GeneralMark, ServiceOption, VisitRecord } from "@/lib/treatment/db";
import { dayOf, lastPlanBefore, planned as plannedOf, standing } from "@/lib/treatment/visits";
import { call, newId, useOptionalTreatmentStore, type TreatmentStore, type VisitFile } from "./store";
import { useChartWork } from "./visit-record-view";
import { routePhrase, useDictation, type TalkField } from "./use-dictation";

type Field = TalkField;
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

const chip =
  "inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full border border-line-strong bg-surface px-4 text-start text-[0.875rem] font-semibold text-ink-700 transition-colors duration-100 hover:bg-sunken disabled:opacity-60";
const heading = "mb-1.5 block text-[0.75rem] font-semibold uppercase tracking-wide text-ink-400";

/** The price list, searched: a tap picks a line, and a name that is not on it can be added as typed. */
function Picker({
  services,
  currency,
  onPick,
  onBack,
}: {
  services: ServiceOption[];
  currency: string;
  onPick: (svc: ServiceOption | null, typed?: string) => void;
  onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const T = t.treatment;
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matches = services.filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.nameAr ?? "").includes(q.trim()));
  const exact = services.some((s) => s.name.toLowerCase() === needle || (s.nameAr ?? "") === q.trim());
  return (
    <div className="rounded-lg border border-line" data-record-picker>
      <div className="flex items-center border-b border-line">
        <button
          type="button"
          onClick={onBack}
          aria-label={t.common.back}
          className="grid h-11 w-11 shrink-0 touch-manipulation place-items-center rounded-ss-lg text-ink-500 hover:bg-sunken hover:text-ink-900"
          data-picker-back
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
        </button>
        <input
          autoFocus
          dir="auto"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={T.searchOrType}
          maxLength={120}
          className="h-11 min-w-0 flex-1 rounded-se-lg bg-surface px-2 text-base focus:outline-none md:text-sm"
          data-record-search
        />
      </div>
      <ul className="max-h-64 overflow-y-auto">
        {matches.slice(0, SHOWN).map((s) => (
          <li key={s.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => {
                onPick(s);
                setQ("");
              }}
              className="flex min-h-11 w-full touch-manipulation items-center gap-3 px-3 text-start text-[0.875rem] hover:bg-sunken"
              data-add-service={s.id}
            >
              <span className="min-w-0 flex-1" dir="auto">
                {(locale === "ar" && s.nameAr) || s.name}
              </span>
              <span className="shrink-0 text-[0.78125rem] text-ink-500 tnum">{fmtMoney(s.price, currency, locale)}</span>
            </button>
          </li>
        ))}
        {needle && !exact && (
          <li>
            <button
              type="button"
              onClick={() => {
                onPick(null, q.trim());
                setQ("");
              }}
              className="flex min-h-11 w-full touch-manipulation flex-col justify-center px-3 py-1.5 text-start hover:bg-sunken"
              data-add-other
            >
              <span className="text-[0.875rem] font-semibold text-brand-700" dir="auto">
                {T.addOther.replace("{name}", q.trim())}
              </span>
              <span className="text-[0.75rem] text-ink-500">{T.otherHint}</span>
            </button>
          </li>
        )}
        {!needle && services.length === 0 && <li className="px-3 py-3 text-[0.8125rem] text-ink-500">{T.noServices}</li>}
      </ul>
    </div>
  );
}

function Sheet({ store, appointmentId }: { store: TreatmentStore; appointmentId: string | null }) {
  const { t, locale } = useI18n();
  const T = t.treatment;
  const { toast } = useToast();
  const router = useRouter();
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
  // What the fields say now, for a phrase that arrives between two renders.
  const live = useRef(text);
  live.current = text;
  const base = `/api/c/${store.slug}/patients/${store.patientId}/treatment`;
  const { patch, state } = useAutosave({
    url: `${base}/records/${recordId}${appointmentId ? `?visit=${appointmentId}` : ""}`,
    entityKey: `visit-record:${recordId}`,
  });

  const set = (f: Field, v: string) => {
    live.current = { ...live.current, [f]: v };
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

  /* ── Talk ─────────────────────────────────────────────────────────────── */
  // Where the words go: the section last named or last tapped.
  const [target, setTarget] = useState<Field>("complaint");
  const targetRef = useRef(target);
  targetRef.current = target;
  const [talkLang, setTalkLang] = useState<"ar" | "en">(locale === "ar" ? "ar" : "en");
  const talk = useDictation({
    lang: talkLang === "ar" ? "ar-JO" : "en-US",
    onPhrase: (phrase) => {
      for (const part of routePhrase(phrase)) {
        if (part.field && part.field !== targetRef.current) {
          targetRef.current = part.field;
          setTarget(part.field);
        }
        if (!part.text) continue;
        const f = targetRef.current;
        const cur = live.current[f];
        set(f, cur.trim() ? `${cur.replace(/\s+$/, "")} ${part.text}` : part.text);
      }
    },
    onError: (why) => toast(why === "denied" ? T.talkDenied : T.talkFailed, "error"),
  });

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

  // What the visit before this one planned: the first thing a follow-up is read against.
  const visitAt = visit?.starts_at ?? existing?.createdAt ?? new Date().toISOString();
  const lastPlan = lastPlanBefore(store.records, store.visits, recordId, visitAt);

  // What is recorded as done at this visit — or, with no visit, today with none.
  const known = new Set(store.visits.map((v) => v.id));
  const done = standing(store.marks).filter((m) =>
    appointmentId ? m.appointmentId === appointmentId : (!m.appointmentId || !known.has(m.appointmentId)) && dayOf(m.doneAt ?? m.createdAt, tz) === today
  );
  const waiting = plannedOf(store.marks);

  // Done by the visit's doctor; with no visit, by whoever is recording when they are a doctor.
  const performer = visit?.doctor_member_id ?? (store.doctors.some((d) => d.id === store.myMemberId) ? store.myMemberId : null);

  const add = async (svc: ServiceOption | null, typed: string | undefined, status: "done" | "planned") => {
    const id = newId();
    const now = new Date().toISOString();
    const doer = status === "done" && performer ? (store.doctors.find((d) => d.id === performer) ?? null) : null;
    const local: GeneralMark = {
      id,
      label: svc?.name ?? typed ?? "",
      labelAr: svc?.nameAr || svc?.name || typed || "",
      serviceId: svc?.id ?? null,
      fee: svc ? svc.price : null,
      status,
      note: "",
      performedBy: doer,
      recordedBy: store.me,
      createdAt: now,
      doneAt: status === "done" ? now : null,
      voidedAt: null,
      appointmentId: status === "done" ? appointmentId : null,
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
          status,
          appointmentId: status === "done" ? appointmentId : null,
          performedBy: status === "done" ? performer : null,
        })
      );
      store.setMarks((prev) => prev.map((m) => (m.id === id ? r.mark : m)));
    } catch {
      store.setMarks((prev) => prev.filter((m) => m.id !== id));
      toast(T.saveFailed, "error");
    }
  };

  /** A treatment an earlier visit planned, done at this one. */
  const finish = async (m: GeneralMark) => {
    const now = new Date().toISOString();
    const doer = performer ? (store.doctors.find((d) => d.id === performer) ?? null) : null;
    store.setMarks((prev) => prev.map((x) => (x.id === m.id ? { ...x, status: "done", doneAt: now, appointmentId, performedBy: doer ?? x.performedBy } : x)));
    try {
      const r = await store.write([m.id], call<{ mark: GeneralMark }>(`${base}/marks/${m.id}`, "PATCH", { op: "done", eventId: newId(), appointmentId, performerId: performer }));
      store.setMarks((prev) => prev.map((x) => (x.id === m.id ? r.mark : x)));
    } catch {
      store.setMarks((prev) => prev.map((x) => (x.id === m.id ? m : x)));
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
  const markName = (m: GeneralMark) => (locale === "ar" && m.labelAr) || m.label;
  const booked = (visit?.service_ids ?? [])
    .map((id) => store.services.find((s) => s.id === id))
    .filter((s): s is ServiceOption => !!s && !done.some((m) => m.serviceId === s.id));

  const [picking, setPicking] = useState<"done" | "planned" | null>(null);

  /* ── The visit's prescriptions and files ──────────────────────────────── */
  const rx = appointmentId ? store.prescriptions.filter((r) => r.appointment_id === appointmentId) : [];
  const files = appointmentId ? store.files.filter((f) => f.appointment_id === appointmentId) : [];
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const upload = async (list: File[]) => {
    if (!list.length) return;
    setUploading((n) => n + list.length);
    let any = false;
    for (const file of list) {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("kind", file.type.startsWith("image/") ? "photo" : "report");
      if (appointmentId) fd.set("appointmentId", appointmentId);
      const res = await fetch(`/api/c/${store.slug}/patients/${store.patientId}/files`, { method: "POST", body: fd }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { file?: VisitFile; error?: string } | null;
      setUploading((n) => n - 1);
      if (!res?.ok || !body?.file) {
        toast(body?.error === "too_large" || res?.status === 413 ? T.fileTooLarge : T.uploadFailed, "error");
        continue;
      }
      store.addFile(body.file);
      any = true;
    }
    // The Files tab reads the page's list: it hears of the new file now.
    if (any) router.refresh();
  };

  // A record with no visit, written today: a visit for now can still be started, and it moves there.
  const isToday = !appointmentId && (existing ? dayOf(existing.createdAt, tz) === today : true);
  const [starting, setStarting] = useState(false);
  const startHere = async () => {
    setStarting(true);
    try {
      await store.startVisit(store.records.some((r) => r.id === recordId) ? recordId : null);
    } catch {
      setStarting(false);
      toast(T.saveFailed, "error");
    }
  };

  const when = visit ? `${fmtDate(visit.starts_at, tz, locale)} · ${fmtTime(visit.starts_at, tz, locale)}` : `${fmtDate(new Date().toISOString(), tz, locale)} · ${T.noVisit}`;
  const service = visit ? (locale === "ar" && visit.service_name_ar) || visit.service_name : null;
  const openChart = (key: string) => {
    store.closeSheet();
    // The chart's tab offers the way back to this record.
    store.setReturnTo({ appointmentId });
    store.goTab(key);
  };

  const area = "w-full rounded-ctl border bg-surface px-3 py-2 text-base text-ink-900 placeholder:text-ink-500 focus:border-brand-600 focus:outline-none md:text-sm";
  const field = (f: Field, rows: number) => {
    const hearingHere = talk.listening && target === f;
    return (
      <label className="block">
        <span className={`${heading} flex items-center gap-1.5`}>
          {T.fields[f]}
          {hearingHere && <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />}
        </span>
        <textarea
          dir="auto"
          rows={rows}
          maxLength={f === "exam" ? 8000 : f === "diagnosis" ? 2000 : 4000}
          value={text[f]}
          onChange={(e) => set(f, e.target.value)}
          onFocus={() => setTarget(f)}
          placeholder={T.placeholders[f]}
          className={`${area} ${hearingHere ? "border-danger" : "border-line"}`}
          data-record-input={f}
          data-talk-target={hearingHere || undefined}
        />
      </label>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={T.recordTitle} data-record-sheet={appointmentId ?? "day"}>
      <button type="button" aria-label={t.common.close} onClick={store.closeSheet} className="absolute inset-0 bg-night/35 animate-fade-in" />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-2xl bg-surface shadow-pop animate-fade-up md:inset-x-auto md:bottom-auto md:left-1/2 md:top-[6vh] md:max-h-[88vh] md:w-full md:max-w-xl md:-translate-x-1/2 md:rounded-2xl">
        <div className="flex items-center gap-1 border-b border-line py-3 pe-5 ps-2">
          {/* Back, where a thumb expects it: the file is right behind the sheet. */}
          <button
            type="button"
            onClick={store.closeSheet}
            className="inline-flex h-11 shrink-0 touch-manipulation items-center gap-1 rounded-full px-3 text-[0.875rem] font-semibold text-ink-700 hover:bg-sunken"
            data-record-back
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
            {t.common.back}
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-[1rem] font-semibold">{T.recordTitle}</h2>
            <p className="truncate text-[0.8125rem] text-ink-500">
              {when}
              {service ? ` · ${service}` : ""}
              {visit?.doctor_name ? ` · ${visit.doctor_name}` : ""}
            </p>
          </div>
        </div>

        {talk.supported && (
          <div className={`flex flex-wrap items-center gap-2 border-b border-line px-5 py-2.5 ${talk.listening ? "bg-danger-soft" : "bg-canvas"}`} data-record-talk={talk.listening ? "on" : "off"}>
            <button
              type="button"
              onClick={() => (talk.listening ? talk.stop() : talk.start())}
              aria-pressed={talk.listening}
              className={`inline-flex h-11 shrink-0 touch-manipulation items-center gap-2 rounded-full px-4 text-[0.875rem] font-semibold ${
                talk.listening ? "bg-danger text-white" : "bg-brand-600 text-on-brand hover:bg-brand-hover"
              }`}
              data-talk-toggle
            >
              {talk.listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {talk.listening ? T.talkStop : T.talk}
            </button>
            {/* The language being spoken: a doctor may read the screen in Arabic and dictate in English. */}
            <div className="inline-flex h-11 shrink-0 overflow-hidden rounded-full border border-line-strong bg-surface" role="radiogroup" aria-label={T.talkLanguage}>
              {(["ar", "en"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={talkLang === l}
                  onClick={() => setTalkLang(l)}
                  className={`touch-manipulation px-3.5 text-[0.8125rem] font-semibold ${talkLang === l ? "bg-ink-900 text-surface" : "text-ink-700 hover:bg-sunken"}`}
                  data-talk-lang={l}
                >
                  {l === "ar" ? "عربي" : "English"}
                </button>
              ))}
            </div>
            {/* On a phone the hint would push the record down three lines: there it is only said while listening. */}
            <p className={`min-w-0 flex-1 basis-full text-[0.78125rem] text-ink-700 sm:basis-0 ${talk.listening ? "" : "max-sm:hidden"}`} aria-live="polite">
              {talk.listening ? (
                <>
                  <span className="font-semibold">
                    {T.talkInto.replace("{field}", T.fields[target])}
                  </span>
                  {talk.hearing ? <span dir="auto"> · {talk.hearing}</span> : null}
                </>
              ) : (
                T.talkHint
              )}
            </p>
          </div>
        )}

        <div className="grid gap-5 overflow-y-auto overscroll-contain px-5 py-4">
          {!appointmentId && isToday && (
            <div className="grid gap-2 rounded-lg border border-st-pending/30 bg-st-pending-soft px-3 py-2.5" data-record-no-visit>
              <p className="text-[0.8125rem] text-ink-900">{T.noVisitHint}</p>
              <div>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => void startHere()}
                  className="inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full bg-brand-600 px-4 text-[0.875rem] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-60"
                  data-record-start-visit
                >
                  <Plus className="h-4 w-4 shrink-0" />
                  {T.startVisit}
                </button>
              </div>
            </div>
          )}

          {lastPlan && (
            <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-[0.8125rem]" data-record-last-plan>
              <div className="mb-0.5 text-[0.75rem] font-semibold text-ink-500">{T.lastPlan.replace("{date}", fmtDate(lastPlan.at, tz, locale))}</div>
              <p className="whitespace-pre-wrap text-ink-900" dir="auto">
                {lastPlan.plan}
              </p>
            </div>
          )}

          <div className="grid gap-2">
            {field("complaint", 2)}
            {said.length > 0 && (
              <div className="rounded-lg bg-canvas px-3 py-2 text-[0.78125rem] text-ink-700" data-record-booking>
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
                <span className="text-[0.75rem] text-ink-500">{T.earlier}</span>
                {earlier.map((d) => (
                  <button key={d} type="button" onClick={() => set("diagnosis", d)} className="inline-flex min-h-9 max-w-full touch-manipulation items-center rounded-full border border-line bg-surface px-3 text-[0.8125rem] text-ink-700 hover:bg-sunken">
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
                    <span className="min-w-0 flex-1 text-[0.875rem] font-medium" dir="auto">
                      {markName(m)}
                    </span>
                    <span className="shrink-0 text-[0.78125rem] text-ink-500 tnum">{m.fee == null ? T.noPrice : fmtMoney(m.fee, store.currency, locale)}</span>
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

            {/*
              A new treatment — neither booked nor planned — is the first thing
              offered, and plainly (Yamen, 2026-11-15: "make a new one other
              than the old and the planned one"): from the price list, or by
              its name when it is not on it.
            */}
            {picking !== "done" ? (
              <button
                type="button"
                onClick={() => setPicking("done")}
                className="mb-3 inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full bg-brand-600 px-4 text-[0.875rem] font-semibold text-on-brand hover:bg-brand-hover"
                data-record-pick
              >
                <Plus className="h-4 w-4 shrink-0" />
                {T.newTreatment}
              </button>
            ) : (
              <div className="mb-3">
                <Picker services={store.services} currency={store.currency} onPick={(s, typed) => void add(s, typed, "done")} onBack={() => setPicking(null)} />
              </div>
            )}

            {/* Or one already in view: what an earlier visit planned, and what this one was booked for. */}
            {waiting.length > 0 && (
              <div className="mb-2" data-record-planned-offer={waiting.length}>
                <div className="mb-1.5 text-[0.75rem] text-ink-500">{T.plannedEarlier}</div>
                <div className="flex flex-wrap gap-2">
                  {waiting.map((m) => (
                    <button key={m.id} type="button" onClick={() => void finish(m)} className={chip} data-finish-planned={m.id}>
                      <Plus className="h-4 w-4 shrink-0" />
                      <span dir="auto">{markName(m)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {booked.length > 0 && (
              <div className="mb-2" data-record-booked={booked.length}>
                <div className="mb-1.5 text-[0.75rem] text-ink-500">{T.booked}</div>
                <div className="flex flex-wrap gap-2">
                  {booked.map((s) => (
                    <button key={s.id} type="button" onClick={() => void add(s, undefined, "done")} className={chip} data-add-booked={s.id}>
                      <Plus className="h-4 w-4 shrink-0" />
                      <span dir="auto">{nameOf(s)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(dental || face) && (
              <div className="mt-3 grid gap-2 rounded-lg bg-canvas p-3" data-record-charts>
                <p className="text-[0.78125rem] text-ink-500">{T.chartHint}</p>
                <div className="flex flex-wrap gap-2">
                  {dental && (
                    <button type="button" onClick={() => openChart("dental")} className={chip} data-open-chart="dental">
                      <Tooth className="h-4 w-4 shrink-0" />
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

          {/* What the visit hands the patient and keeps of them: filed under the visit, wherever else they are also listed. */}
          {appointmentId && (
            <section data-record-attached={rx.length + files.length}>
              <h3 className={heading}>{T.rxAndFiles}</h3>
              {(rx.length > 0 || files.length > 0) && (
                <ul className="mb-2 grid gap-1.5">
                  {rx.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-[0.875rem]" data-record-rx={r.id}>
                      <Pill className="h-4 w-4 shrink-0 text-ink-500" />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{T.rxNumber.replace("{n}", String(r.number))}</span>
                        <span className="block truncate text-[0.78125rem] text-ink-500" dir="auto">
                          {r.items.map((i) => i.name).filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </li>
                  ))}
                  {files.map((f) => (
                    <li key={f.id} data-record-file={f.id}>
                      <a href={`/api/c/${store.slug}/files/${f.id}`} target="_blank" rel="noopener" className="flex min-h-11 items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-[0.875rem] hover:bg-sunken">
                        {f.mime_type.startsWith("image/") ? (
                          <img src={`/api/c/${store.slug}/files/${f.id}?thumb=1`} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-ink-500" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                          {f.file_name}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {store.prescribe && (
                  <button type="button" onClick={() => store.prescribe!(appointmentId, text.diagnosis)} className={chip} data-record-prescribe>
                    <Pill className="h-4 w-4 shrink-0" />
                    {T.prescribe}
                  </button>
                )}
                <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading > 0} className={chip} data-record-add-file>
                  <Paperclip className="h-4 w-4 shrink-0" />
                  {uploading > 0 ? T.uploading : T.addFile}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept="image/*,application/pdf,.dcm"
                  className="hidden"
                  onChange={(e) => {
                    const list = [...(e.target.files ?? [])];
                    e.target.value = "";
                    void upload(list);
                  }}
                  data-record-file-input
                />
              </div>
            </section>
          )}

          <section className="grid gap-2">
            {field("plan", 2)}
            {/* The plan as things to do, not only words: each waits on the record until a visit marks it done. */}
            <div data-record-planned={waiting.length}>
              <div className="mb-1.5 text-[0.75rem] text-ink-500">{T.forLater}</div>
              {waiting.length > 0 && (
                <ul className="mb-2 grid gap-1.5">
                  {waiting.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 rounded-lg bg-canvas py-1 pe-1 ps-3" data-planned-line={m.id}>
                      <span className="min-w-0 flex-1 text-[0.875rem] font-medium" dir="auto">
                        {markName(m)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void remove(m)}
                        aria-label={`${T.remove}: ${m.label}`}
                        className="grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full text-ink-500 hover:bg-danger-soft hover:text-danger"
                        data-planned-remove={m.id}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {picking !== "planned" ? (
                <button type="button" onClick={() => setPicking("planned")} className={chip} data-record-plan-pick>
                  <Plus className="h-4 w-4 shrink-0" />
                  {T.addLater}
                </button>
              ) : (
                <Picker services={store.services} currency={store.currency} onPick={(s, typed) => void add(s, typed, "planned")} onBack={() => setPicking(null)} />
              )}
            </div>
          </section>
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

