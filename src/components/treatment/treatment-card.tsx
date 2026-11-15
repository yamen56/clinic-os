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
import { ChevronDown, ClipboardPen, Pencil, Stethoscope } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/dates";
import { buildEntries, hasText, planned, todaysVisitId, type Entry } from "@/lib/treatment/visits";
import { useOptionalTreatmentStore } from "./store";
import { useChartWork, VisitRecordView, type ChartWork } from "./visit-record-view";

const SHOWN = 3;

export function TreatmentCard({ className = "", currentVisitId }: { className?: string; /** The visit in progress, when the patient is in the clinic. */ currentVisitId: string | null }) {
  const { t, locale } = useI18n();
  const T = t.treatment;
  const store = useOptionalTreatmentStore();
  const chart = useChartWork();
  const [all, setAll] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (!store) return null;
  const { tz } = store;

  // A visit is listed for anything it left behind: its record, its treatments, its chart work, a prescription, a file.
  const withSomething = new Set<string>(chart.keys());
  for (const r of store.prescriptions) if (r.appointment_id) withSomething.add(r.appointment_id);
  for (const f of store.files) if (f.appointment_id) withSomething.add(f.appointment_id);
  const entries = buildEntries(store.records, store.marks, store.visits, tz, withSomething);
  // What earlier visits planned and no visit has done yet: the first thing to know before today's.
  const waiting = planned(store.marks);
  // What a doctor is here to write: the visit in progress, else today's, else today with no visit.
  const target = currentVisitId ?? todaysVisitId(store.visits, tz);
  const shown = all ? entries : entries.slice(0, SHOWN);

  return (
    <div className={className} data-treatment-card={entries.length}>
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            <Stethoscope className="h-4 w-4 text-ink-500" />
            {T.title}
          </h3>
          {store.canWrite && (
            <Button size="sm" onClick={() => store.openSheet(target)} data-treatment-record>
              <ClipboardPen className="h-4 w-4" />
              {T.record}
            </Button>
          )}
        </div>

        {waiting.length > 0 && (
          <div className="mb-3 rounded-lg border border-line bg-canvas px-3 py-2.5" data-treatment-planned={waiting.length}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{T.planned}</div>
            <ul className="grid gap-1">
              {waiting.map((m) => (
                <li key={m.id} className="text-[13.5px] text-ink-900">
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
            <p className="text-[14px] font-medium text-ink-700">{T.empty}</p>
            <p className="mt-0.5 text-[13px] text-ink-500">{T.emptyHint}</p>
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
            className="mt-3 inline-flex min-h-10 touch-manipulation items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-brand-700 hover:bg-sunken"
            data-treatment-all={all}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${all ? "rotate-180" : ""}`} />
            {all ? T.showLess : T.showAll.replace("{n}", String(entries.length))}
          </button>
        )}
      </Card>
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
            <span className="block text-[13.5px] font-semibold text-ink-900">{fmtDate(entry.at, tz, locale)}</span>
            {/* Each name isolated: a doctor's English name beside an Arabic service must not reorder the line. */}
            <span className="block text-[12.5px] text-ink-500">
              {[who, service ?? (!v ? noVisit : null)].filter(Boolean).map((x, i) => (
                <span key={i}>
                  {i > 0 ? " · " : ""}
                  <bdi>{x}</bdi>
                </span>
              ))}
            </span>
            {!open && gist && (
              <span className="mt-0.5 block truncate text-[13px] text-ink-700" dir="auto">
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
        </div>
      )}
    </li>
  );
}
