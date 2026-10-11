"use client";

/*
  What was done at each visit of a case.

  How a dentist reads a course of treatment: visit by visit. "10 Oct, Dr.
  Sara: 36 access, working length MB 21 · DB 20.5 · P 22 mm, irrigation; 14
  Oct: 36 obturation." Each step is listed under the visit it was done at — a
  walk-in under its day — and work that has no steps under the visit it was
  done at, newest first.
*/

import { Siren } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtDateTime } from "@/lib/dates";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { EMERGENCY_STEP, protocolFor, stepOf, stepSummary } from "@/lib/charts/dental/protocols";
import { sessionKey } from "@/lib/charts/dental/treatment";
import { useDentalStore } from "./store";
import { markLabel } from "./labels";

type Line = { at: string; mark: Mark; what: string; summary: string; who: string; urgent: boolean; appointmentId: string | null };

export function VisitsList({ tz }: { tz: string }) {
  const { t, locale } = useI18n();
  const P = t.dental.treatment;
  const { marks, steps, visits, activeCaseId } = useDentalStore();

  const inCase = new Map(marks.filter((m) => m.caseId === activeCaseId && !m.voidedAt).map((m) => [m.id, m]));
  const groups = new Map<string, Line[]>();
  const add = (key: string, line: Line) => groups.set(key, [...(groups.get(key) ?? []), line]);

  for (const s of steps) {
    const m = inCase.get(s.markId);
    if (!m || s.voidedAt) continue;
    const urgent = s.step === EMERGENCY_STEP;
    const def = urgent ? null : stepOf(m.treatmentKey, s.step);
    add(sessionKey(s, tz), {
      at: s.doneAt,
      mark: m,
      what: urgent ? P.emergency : (def?.en ?? s.step),
      summary: urgent
        ? [s.data.complaint, ...((s.data.done as string[] | undefined) ?? []).map((k) => (P.emergencyActions as Record<string, string>)[k] ?? k)].filter(Boolean).join(" · ")
        : stepSummary(def, s.data),
      who: s.performedBy?.name ?? s.recordedBy.name,
      urgent,
      appointmentId: s.appointmentId,
    });
  }
  // Work with no steps: done in one go, at the visit it was done at.
  for (const m of inCase.values()) {
    if (m.status !== "done" || protocolFor(m.treatmentKey) || !m.doneAt) continue;
    add(sessionKey({ doneAt: m.doneAt }, tz), {
      at: m.doneAt,
      mark: m,
      what: t.dental.status.done,
      summary: m.note,
      who: m.performedBy?.name ?? m.recordedBy.name,
      urgent: m.emergency,
      appointmentId: m.appointmentId,
    });
  }

  const ordered = [...groups.entries()]
    .map(([key, lines]) => ({ key, lines: lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), last: Math.max(...lines.map((l) => Date.parse(l.at))) }))
    .sort((a, b) => b.last - a.last);

  return (
    <section className="grid gap-3" data-visits>
      <h3 className="font-display text-base font-semibold text-ink-900">{P.visits}</h3>
      {ordered.length === 0 ? (
        <p className="text-[13px] text-ink-500">{P.noVisits}</p>
      ) : (
        <ol className="grid gap-3">
          {ordered.map(({ key, lines }) => {
            // The day's booked visit, when the work was done at one: its time, its doctor.
            const booked = lines.map((l) => l.appointmentId).find(Boolean);
            const visit = booked ? visits.find((v) => v.id === booked) : undefined;
            const day = key.slice(4);
            return (
              <li key={key} className="rounded-card border border-line bg-surface p-3" data-visit={key}>
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[13px]">
                  <span className="font-semibold text-ink-900">{visit ? fmtDateTime(visit.startsAt, tz, locale) : day ? fmtDateOnly(day, locale) : ""}</span>
                  <span className="text-ink-500">{[visit?.doctor, visit?.service, !visit ? P.walkIn : null].filter(Boolean).join(" · ")}</span>
                </div>
                <ul className="grid gap-1">
                  {lines.map((l, i) => (
                    <li key={i} className="flex items-start gap-2 text-[13px]">
                      {l.urgent && <Siren className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />}
                      <span className="min-w-0">
                        <span className="font-semibold text-ink-900">
                          {isToothSite(l.mark.site) ? `${l.mark.site} ` : ""}
                          {markLabel(l.mark, locale)}
                        </span>
                        <span className="text-ink-700"> — {l.what}</span>
                        {l.summary && <span className="text-ink-500"> · {l.summary}</span>}
                        <span className="text-ink-400"> · {l.who}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
