"use client";

/*
  The Overview's Treatment card: what has been done for this patient, visit
  by visit, newest first — and the way in to record today's.

  It is first on the Overview, above the medical history (Yamen, 2026-11-15:
  "make it above the medical history") — the medical alerts already head the
  file, over every tab. The latest visit is open; the ones before it are a line each — the
  day, the doctor, the diagnosis, what was done — and open on a tap. Three
  are shown, and Show all brings the rest in place: the full record is this
  card, not another screen.

  A clinic with a chart sees its tooth or face work here by itself, under
  the visit it was done at (Yamen, 2026-11-15: "connected to the charts").
*/

import { useState } from "react";
import { DateTime } from "luxon";
import { CalendarDays, ChevronDown, ChevronRight, ClipboardPen, Pencil, Stethoscope } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Field, Input } from "@/components/ui/input";
import { todayIn } from "@/lib/dates";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fmtDate } from "@/lib/dates";
import { buildEntries, hasText, planned, todaysVisitId, type Entry } from "@/lib/treatment/visits";
import { useOptionalTreatmentStore } from "./store";
import { useChartWork, VitalChips, VisitRecordView, type ChartWork } from "./visit-record-view";
import { hasVitals } from "@/lib/treatment/vitals";

const SHOWN = 3;

export function TreatmentCard({ className = "", currentVisitId }: { className?: string; /** The visit in progress, when the patient is in the clinic. */ currentVisitId: string | null }) {
  const { t, locale } = useI18n();
  const T = t.treatment;
  const store = useOptionalTreatmentStore();
  const chart = useChartWork();
  const [all, setAll] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [starting, setStarting] = useState(false);
  /* "Another day": the day picked for a visit written up afterwards (2026-11-20). */
  const [otherDay, setOtherDay] = useState<string | null>(null);
  const { toast } = useToast();
  if (!store) return null;
  const { tz } = store;

  /*
    A visit on an earlier day: its own sheet when the patient had a visit that
    day, else one made for that day, already over — so what is recorded in it
    is dated that day (visitFor), and nothing is sent to the patient.
  */
  const recordOn = async (day: string) => {
    if (day >= todayIn(tz)) {
      setOtherDay(null);
      return record();
    }
    const had = store.visits.find(
      (v) => !["cancelled", "no_show"].includes(v.status) && DateTime.fromISO(v.starts_at).setZone(tz).toISODate() === day
    );
    if (had) {
      setOtherDay(null);
      return store.openSheet(had.id);
    }
    setStarting(true);
    try {
      await store.startVisit(null, day);
      setOtherDay(null);
    } catch {
      toast(T.saveFailed, "error");
    } finally {
      setStarting(false);
    }
  };

  // A visit is listed for anything it left behind: its record, its treatments, its chart work, a prescription, a file.
  const withSomething = new Set<string>(chart.keys());
  for (const r of store.prescriptions) if (r.appointment_id) withSomething.add(r.appointment_id);
  for (const f of store.files) if (f.appointment_id) withSomething.add(f.appointment_id);
  const entries = buildEntries(store.records, store.marks, store.visits, tz, withSomething);
  // What earlier visits planned and no visit has done yet: the first thing to know before today's.
  const waiting = planned(store.marks);
  /*
    The vital signs, newest visit first: the latest reading on top of the
    card with the one before beside each number, so a blood pressure or a
    weight is read as a trend, not a number on its own.
  */
  const visitAt = new Map(store.visits.map((v) => [v.id, v.starts_at]));
  const whenOf = (r: (typeof store.records)[number]) => (r.appointmentId ? visitAt.get(r.appointmentId) : undefined) ?? r.createdAt;
  const latestVitals = store.records.filter((r) => hasVitals(r.vitals)).sort((a, b) => Date.parse(whenOf(b)) - Date.parse(whenOf(a)));
  // What a doctor is here to write: the visit in progress, else today's, else today with no visit.
  const target = currentVisitId ?? todaysVisitId(store.visits, tz);
  const shown = all ? entries : entries.slice(0, SHOWN);
  /*
    Record visit, for a patient with no appointment today, starts one — a
    walk-in, with this doctor, now — so the record, the prescription and the
    files have a visit to go under, and the visit is in the calendar.
  */
  const record = async () => {
    if (target) return store.openSheet(target);
    setStarting(true);
    try {
      const today = new Date().toDateString();
      const loose = store.records.find((r) => !r.appointmentId && new Date(r.createdAt).toDateString() === today);
      await store.startVisit(loose?.id ?? null);
    } catch {
      toast(T.saveFailed, "error");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className={className} data-treatment-card={entries.length}>
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[0.9375rem] font-semibold">
            <Stethoscope className="h-4 w-4 text-ink-500" />
            {T.title}
          </h3>
          {store.canWrite && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setOtherDay(DateTime.now().setZone(tz).minus({ days: 1 }).toISODate()!)} data-treatment-other-day>
                <CalendarDays className="h-4 w-4" />
                {T.anotherDay}
              </Button>
              <Button size="sm" onClick={() => void record()} loading={starting && otherDay === null} data-treatment-record>
                <ClipboardPen className="h-4 w-4" />
                {T.record}
              </Button>
            </div>
          )}
        </div>

        {latestVitals.length > 0 && (
          <div className="mb-3 rounded-lg border border-line px-3 py-2.5" data-treatment-vitals>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[0.75rem]">
              <span className="font-semibold text-ink-700">{t.vitals.latest}</span>
              <span className="text-ink-500">{fmtDate(whenOf(latestVitals[0]), tz, locale)}</span>
            </div>
            <VitalChips record={latestVitals[0]} previous={latestVitals.slice(1)} bare />
          </div>
        )}

        {waiting.length > 0 && (
          <div className="mb-3 rounded-lg border border-line bg-canvas px-3 py-2.5" data-treatment-planned={waiting.length}>
            <div className="mb-1 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">{T.planned}</div>
            <ul className="grid gap-1">
              {waiting.map((m) => (
                <li key={m.id} className="text-[0.84375rem] text-ink-900">
                  <span className="font-medium" dir="auto">
                    {(locale === "ar" && m.labelAr) || m.label}
                  </span>
                  <span className="text-ink-500"> · {fmtDate(m.createdAt, tz, locale)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {entries.length === 0 && waiting.length > 0 ? null : entries.length === 0 ? (
          <div className="py-2" data-treatment-empty>
            <p className="text-[0.875rem] font-medium text-ink-700">{T.empty}</p>
            <p className="mt-0.5 text-[0.8125rem] text-ink-500">{T.emptyHint}</p>
          </div>
        ) : (
          <ul className="grid gap-2">
            {shown.map((e, i) => (
              <EntryRow
                key={e.key}
                entry={e}
                chart={e.appointmentId ? chart.get(e.appointmentId) : undefined}
                // The latest opens by itself; a tap says otherwise for either.
                open={toggled[e.key] ?? i === 0}
                onToggle={() => setToggled((p) => ({ ...p, [e.key]: !(p[e.key] ?? i === 0) }))}
                tz={tz}
                locale={locale}
                canWrite={store.canWrite}
                onEdit={() => store.openSheet(e.appointmentId)}
                onTab={store.goTab}
                onAppointment={e.appointmentId && store.showAppointment ? () => store.showAppointment!(e.appointmentId!) : undefined}
                appointmentLabel={T.appointmentDetails}
                noVisit={T.noVisit}
                editLabel={T.edit}
                countLabel={T.count}
              />
            ))}
          </ul>
        )}

        {entries.length > SHOWN && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="mt-3 inline-flex min-h-10 touch-manipulation items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold text-brand-700 hover:bg-sunken"
            data-treatment-all={all}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${all ? "rotate-180" : ""}`} />
            {all ? T.showLess : T.showAll.replace("{n}", String(entries.length))}
          </button>
        )}
      </Card>

      <Modal open={otherDay !== null} onClose={() => setOtherDay(null)} title={T.anotherDayTitle}>
        {otherDay !== null && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (otherDay) void recordOn(otherDay);
            }}
            data-treatment-other-day-form
          >
            <p className="text-[0.8125rem] leading-relaxed text-ink-500">{T.anotherDayHint}</p>
            <Field label={t.common.date}>
              <Input type="date" dir="ltr" value={otherDay} max={todayIn(tz)} onChange={(e) => setOtherDay(e.target.value)} data-treatment-other-day-input />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOtherDay(null)}>
                {t.common.cancel}
              </Button>
              <Button type="submit" loading={starting} disabled={!otherDay} data-treatment-other-day-open>
                {T.openVisit}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function EntryRow({
  entry,
  chart,
  open,
  onToggle,
  tz,
  locale,
  canWrite,
  onEdit,
  onTab,
  onAppointment,
  appointmentLabel,
  noVisit,
  editLabel,
  countLabel,
}: {
  entry: Entry;
  chart: ChartWork | undefined;
  open: boolean;
  onToggle: () => void;
  tz: string;
  locale: string;
  canWrite: boolean;
  onEdit: () => void;
  onTab: (key: string) => void;
  onAppointment?: () => void;
  appointmentLabel: string;
  noVisit: string;
  editLabel: string;
  countLabel: string;
}) {
  const v = entry.visit;
  const service = v ? (locale === "ar" && v.service_name_ar) || v.service_name : null;
  const who = v?.doctor_name ?? entry.record?.recordedBy?.name ?? entry.marks[0]?.performedBy?.name ?? null;
  // The one line a closed visit says: the diagnosis, else what was done.
  const names = entry.marks.map((m) => (locale === "ar" && m.labelAr) || m.label);
  const doneCount = entry.marks.length + (chart?.dental ?? 0) + (chart?.face.length ?? 0);
  const gist = (hasText(entry.record) && entry.record!.diagnosis.trim()) || names.join(" · ") || (doneCount ? countLabel.replace("{n}", String(doneCount)) : "");

  return (
    <li className="rounded-lg border border-line" data-treatment-entry={entry.key} data-entry-open={open}>
      <div className="flex items-start gap-1 p-1">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-11 min-w-0 flex-1 touch-manipulation items-start gap-2 rounded-md px-2 py-1.5 text-start hover:bg-sunken">
          <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-[0.84375rem] font-semibold text-ink-900">{fmtDate(entry.at, tz, locale)}</span>
            {/* Each name isolated: a doctor's English name beside an Arabic service must not reorder the line. */}
            <span className="block text-[0.78125rem] text-ink-500">
              {[who, service ?? (!v ? noVisit : null)].filter(Boolean).map((x, i) => (
                <span key={i}>
                  {i > 0 ? " · " : ""}
                  <bdi>{x}</bdi>
                </span>
              ))}
            </span>
            {!open && gist && (
              <span className="mt-0.5 block truncate text-[0.8125rem] text-ink-700" dir="auto">
                {gist}
              </span>
            )}
          </span>
        </button>
        {canWrite && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={editLabel}
            title={editLabel}
            className="grid h-11 w-11 shrink-0 touch-manipulation place-items-center rounded-full text-ink-500 hover:bg-sunken hover:text-ink-900"
            data-entry-edit={entry.key}
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-line px-4 py-3">
          <VisitRecordView appointmentId={entry.appointmentId} record={entry.record} marks={entry.marks} chart={chart} onTab={onTab} />
          {onAppointment && (
            <button
              type="button"
              onClick={onAppointment}
              className="mt-3 inline-flex min-h-10 touch-manipulation items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-[0.8125rem] font-semibold text-ink-700 hover:bg-sunken"
              data-entry-appointment={entry.appointmentId}
            >
              <CalendarDays className="h-4 w-4" />
              {appointmentLabel}
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}
