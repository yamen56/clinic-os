"use client";

/*
  One visit of the treatment record, read: what it was — complaint,
  examination, diagnosis, plan — and what was done at it.

  What was done comes from three places and is shown as one list: the
  treatments no chart draws (the record's own), and the visit's share of the
  tooth chart and the face chart, read from the charts the file already
  holds. Chart work opens on its chart, where it is edited; nothing here
  enters it a second time.

  The same view serves the Overview's card and an opened row of the
  Appointments tab, so a visit reads the same wherever it is opened.
*/

import { ScanFace, Smile } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { VisitWork } from "@/components/charts/dental/visit-work";
import { useOptionalDentalStore } from "@/components/charts/dental/store";
import { useOptionalFaceStore } from "@/components/charts/face/store";
import { whereText } from "@/lib/charts/face/catalog";
import type { FaceMark } from "@/lib/charts/face/db";
import type { GeneralMark, VisitRecord } from "@/lib/treatment/db";
import { hasText } from "@/lib/treatment/visits";

/** A visit's share of the charts: how much tooth work, and which face work. */
export type ChartWork = { dental: number; face: FaceMark[] };

/**
 * What the charts hold for each visit. A hook, not a function of the entry:
 * the charts are in their own stores, and a file without one has none.
 */
export function useChartWork(): Map<string, ChartWork> {
  const dental = useOptionalDentalStore();
  const face = useOptionalFaceStore();
  const out = new Map<string, ChartWork>();
  const at = (id: string) => {
    let w = out.get(id);
    if (!w) {
      w = { dental: 0, face: [] };
      out.set(id, w);
    }
    return w;
  };
  if (dental) {
    const standing = new Map(dental.marks.filter((m) => !m.voidedAt).map((m) => [m.id, m]));
    // One per treatment a visit touched: finished at it, or a step of it done there.
    const seen = new Set<string>();
    const touch = (appointmentId: string | null, markId: string) => {
      if (!appointmentId || !standing.has(markId) || seen.has(`${appointmentId}:${markId}`)) return;
      seen.add(`${appointmentId}:${markId}`);
      at(appointmentId).dental++;
    };
    for (const m of standing.values()) if (m.status === "done") touch(m.appointmentId, m.id);
    for (const s of dental.steps) if (!s.voidedAt) touch(s.appointmentId, s.markId);
  }
  if (face) {
    for (const m of face.marks) if (!m.voidedAt && m.appointmentId) at(m.appointmentId).face.push(m);
  }
  return out;
}

const FIELDS = ["diagnosis", "complaint", "exam", "plan"] as const;

export function VisitRecordView({
  appointmentId,
  record,
  marks,
  chart,
  onTab,
}: {
  appointmentId: string | null;
  record: VisitRecord | null;
  /** The treatments no chart draws, done at this visit. */
  marks: GeneralMark[];
  chart: ChartWork | undefined;
  /** Show another tab of the file: a chart's work opens on its chart. */
  onTab: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.treatment;
  const written = hasText(record);
  if (!written && !marks.length && !chart?.dental && !chart?.face.length) return null;

  return (
    <div className="grid gap-3" data-visit-record={appointmentId ?? "day"}>
      {written && (
        <dl className="grid gap-2">
          {FIELDS.filter((f) => record![f].trim()).map((f) => (
            <div key={f} data-record-field={f}>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{T.fields[f]}</dt>
              <dd className={`whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-900 ${f === "diagnosis" ? "font-semibold" : ""}`} dir="auto">
                {record![f]}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {marks.length > 0 && (
        <div data-record-done={marks.length}>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{T.done}</div>
          <ul className="grid gap-1">
            {marks.map((m) => (
              <li key={m.id} className="text-[13.5px] text-ink-900" data-record-mark={m.id}>
                <span className="font-medium" dir="auto">
                  {(locale === "ar" && m.labelAr) || m.label}
                </span>
                {m.performedBy?.name ? <span className="text-ink-500"> · {m.performedBy.name}</span> : null}
                {m.note.trim() ? (
                  <span className="block whitespace-pre-wrap text-[12.5px] text-ink-500" dir="auto">
                    {m.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The visit's tooth work, as the chart lists it; a line opens it there. */}
      {appointmentId && !!chart?.dental && (
        <div data-record-dental={chart.dental}>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            <Smile className="h-3.5 w-3.5" />
            {T.toothChart}
          </div>
          <VisitWork appointmentId={appointmentId} onOpenChart={() => onTab("dental")} />
        </div>
      )}

      {!!chart?.face.length && (
        <div data-record-face={chart.face.length}>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            <ScanFace className="h-3.5 w-3.5" />
            {T.faceChart}
          </div>
          <ul className="grid gap-1">
            {chart.face.map((m) => {
              const where = whereText(
                m.areas.map((a) => a.zone),
                locale
              );
              return (
                <li key={m.id}>
                  <button type="button" onClick={() => onTab("face")} className="text-start text-[13.5px] text-ink-900 hover:text-brand-700">
                    <span className="font-medium">{(locale === "ar" && m.labelAr) || m.label}</span>
                    {where ? <span className="text-ink-500"> · {where}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
