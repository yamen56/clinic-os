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

import { FileText, Pill, ScanFace } from "lucide-react";
import { Tooth } from "@/components/ui/tooth-icon";
import { useI18n } from "@/lib/i18n/client";
import { VisitWork } from "@/components/charts/dental/visit-work";
import { useOptionalDentalStore } from "@/components/charts/dental/store";
import { useOptionalFaceStore } from "@/components/charts/face/store";
import { whereText } from "@/lib/charts/face/catalog";
import type { FaceMark } from "@/lib/charts/face/db";
import type { GeneralMark, VisitRecord } from "@/lib/treatment/db";
import { hasText } from "@/lib/treatment/visits";
import { hasVitals, vitalParts } from "@/lib/treatment/vitals";
import { useOptionalTreatmentStore } from "./store";

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

/** A visit's vital signs as a row of chips; amber outside the usual adult range. */
export function VitalChips({
  record,
  previous,
  bare,
}: {
  record: VisitRecord;
  previous?: VisitRecord[];
  /** Without its own heading, inside a box that has one. */
  bare?: boolean;
}) {
  const { t } = useI18n();
  const V = t.vitals;
  const parts = vitalParts(record.vitals, V);
  // The same reading the visit before, for the card's latest: the first earlier record that has it.
  const before = (key: string) => {
    for (const r of previous ?? []) {
      const p = vitalParts(r.vitals, V).find((x) => x.key === key);
      if (p) return p.value;
    }
    return null;
  };
  return (
    <div data-record-vitals-view>
      {!bare && <div className="mb-1 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">{V.title}</div>}
      <ul className="flex flex-wrap gap-1.5">
        {parts.map((p) => {
          const was = previous ? before(p.key) : null;
          return (
            <li
              key={p.key}
              className={`rounded-lg px-2.5 py-1 text-[0.78125rem] ${p.unusual ? "bg-st-pending-soft text-st-pending" : "bg-canvas text-ink-900"}`}
              data-vital-chip={p.key}
            >
              <span className={p.unusual ? "" : "text-ink-500"}>{p.label}</span>{" "}
              <bdi className="font-semibold tnum">{p.value}</bdi>
              {was && was !== p.value && (
                <span className="block text-[length:max(11px,0.6875rem)] text-ink-500">
                  {V.previous.replace("{value}", "")}
                  <bdi className="tnum">{was}</bdi>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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
  const store = useOptionalTreatmentStore();
  const written = hasText(record);
  // What the visit handed the patient and kept of them: filed under it (prescriptions since 0088, files since 0109).
  const rx = store && appointmentId ? store.prescriptions.filter((r) => r.appointment_id === appointmentId) : [];
  const files = store && appointmentId ? store.files.filter((f) => f.appointment_id === appointmentId) : [];
  if (!written && !marks.length && !chart?.dental && !chart?.face.length && !rx.length && !files.length) return null;

  return (
    <div className="grid gap-3" data-visit-record={appointmentId ?? "day"}>
      {written && hasVitals(record!.vitals) && <VitalChips record={record!} />}
      {written && (
        <dl className="grid gap-2">
          {FIELDS.filter((f) => record![f].trim()).map((f) => (
            <div key={f} data-record-field={f}>
              <dt className="text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">{T.fields[f]}</dt>
              <dd className={`whitespace-pre-wrap text-[0.84375rem] leading-relaxed text-ink-900 ${f === "diagnosis" ? "font-semibold" : ""}`} dir="auto">
                {record![f]}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {marks.length > 0 && (
        <div data-record-done={marks.length}>
          <div className="mb-1 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">{T.done}</div>
          <ul className="grid gap-1">
            {marks.map((m) => (
              <li key={m.id} className="text-[0.84375rem] text-ink-900" data-record-mark={m.id}>
                <span className="font-medium" dir="auto">
                  {(locale === "ar" && m.labelAr) || m.label}
                </span>
                {m.performedBy?.name ? <span className="text-ink-500"> · {m.performedBy.name}</span> : null}
                {m.note.trim() ? (
                  <span className="block whitespace-pre-wrap text-[0.78125rem] text-ink-500" dir="auto">
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
          <div className="mb-1 flex items-center gap-1.5 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">
            <Tooth className="h-3.5 w-3.5" />
            {T.toothChart}
          </div>
          <VisitWork appointmentId={appointmentId} onOpenChart={() => onTab("dental")} />
        </div>
      )}

      {(rx.length > 0 || files.length > 0) && store && (
        <div data-record-attached-view={rx.length + files.length}>
          <div className="mb-1 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">{T.rxAndFiles}</div>
          <ul className="grid gap-1">
            {rx.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onTab("prescriptions")} className="flex w-full items-start gap-2 text-start text-[0.84375rem] text-ink-900 hover:text-brand-700" data-view-rx={r.id}>
                  <Pill className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
                  <span className="min-w-0">
                    <span className="font-medium">{T.rxNumber.replace("{n}", String(r.number))}</span>
                    <span className="text-ink-500" dir="auto">
                      {r.items.some((i) => i.name) ? ` · ${r.items.map((i) => i.name).filter(Boolean).join(" · ")}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {files.map((f) => (
              <li key={f.id}>
                <a href={`/api/c/${store.slug}/files/${f.id}`} target="_blank" rel="noopener" className="flex items-center gap-2 text-[0.84375rem] text-ink-900 hover:text-brand-700" data-view-file={f.id}>
                  {f.mime_type.startsWith("image/") ? (
                    <img src={`/api/c/${store.slug}/files/${f.id}?thumb=1`} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded-md object-cover" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-ink-500" />
                  )}
                  <span className="min-w-0 truncate font-medium" dir="auto">
                    {f.file_name}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!chart?.face.length && (
        <div data-record-face={chart.face.length}>
          <div className="mb-1 flex items-center gap-1.5 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">
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
                  <button type="button" onClick={() => onTab("face")} className="text-start text-[0.84375rem] text-ink-900 hover:text-brand-700">
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
