"use client";

/*
  A visit's dental work, under the appointment in the patient's Appointments
  tab: what was done at it and what it is still booked for.

  The visits of a treatment are the patient's appointments (Yamen,
  2026-10-12): a step done on a day the patient has an appointment is filed
  under it, and the appointment shows it. One line per treatment, as the chart
  lists them — a full arch under its lead, not a line for each of its teeth —
  with the steps done at the visit after it. The calendar's appointment panel
  lists a visit the same way, with the same line.
*/

import { useI18n } from "@/lib/i18n/client";
import type { Dict } from "@/lib/i18n/en";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { EMERGENCY_STEP, stepOf } from "@/lib/charts/dental/protocols";
import { groupLeads } from "@/lib/charts/dental/full-arch";
import { visitLines, type VisitLine } from "@/lib/charts/dental/treatment";
import { useOptionalDentalStore, type DentalStore } from "./store";

/** Where on the mouth, as short as it can be said: the tooth, or the arch, quadrant or mouth by name. */
export function whereOf(site: string, t: Dict): string {
  return isToothSite(site) ? site : ((t.dental.sites as Record<string, string>)[site] ?? "·");
}

/** One treatment as a visit lists it: where, what, and the steps done there. */
export function VisitLineView({ line, onOpen }: { line: Pick<VisitLine, "markId" | "site" | "label" | "labelAr" | "treatmentKey" | "steps">; onOpen?: () => void }) {
  const { t, locale } = useI18n();
  const steps = line.steps.map((s) => (s === EMERGENCY_STEP ? t.calendar.emergencyStep : (stepOf(line.treatmentKey, s)?.en ?? s)));
  const body = (
    <>
      <span className="grid h-6 min-w-6 shrink-0 place-items-center rounded-md bg-surface px-1.5 text-[12px] font-bold tnum shadow-card" dir="ltr">
        {whereOf(line.site, t)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{(locale === "ar" && line.labelAr) || line.label}</span>
        {steps.length > 0 && (
          <span className="block text-[12px] text-ink-500">
            <bdi>{steps.join(", ")}</bdi>
          </span>
        )}
      </span>
    </>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-2 text-start text-[13px] hover:text-brand-700" data-visit-work-item={line.markId}>
      {body}
    </button>
  ) : (
    <div className="flex items-start gap-2 text-[13px]">{body}</div>
  );
}

function workOf(store: DentalStore, appointmentId: string): { planned: Mark[]; done: VisitLine[] } {
  const byId = new Map(store.marks.map((m) => [m.id, m]));
  const leads = groupLeads(store.marks);
  const done = visitLines(
    [
      ...store.marks
        .filter((m) => !m.voidedAt && m.status === "done" && m.appointmentId === appointmentId)
        .map((m) => ({ markId: m.id, step: null, at: m.doneAt ?? m.createdAt })),
      ...store.steps
        .filter((s) => !s.voidedAt && s.appointmentId === appointmentId && byId.get(s.markId) && !byId.get(s.markId)!.voidedAt)
        .map((s) => ({ markId: s.markId, step: s.step, at: s.doneAt })),
    ],
    byId,
    (g) => leads.get(g)?.id ?? null
  );
  // A treatment booked for the visit and worked on at it is said once, as done.
  const worked = new Set(done.map((d) => d.markId));
  const planned = store.bookings
    .filter((b) => b.appointmentId === appointmentId && !worked.has(b.markId))
    .map((b) => byId.get(b.markId))
    .filter((m): m is Mark => !!m && !m.voidedAt && m.status === "planned");
  return { planned, done };
}

/** How many treatments a visit holds — worked on there or booked for it — for the chip on its row. */
export function useVisitWorkCount(appointmentId: string): number {
  const store = useOptionalDentalStore();
  if (!store) return 0;
  const w = workOf(store, appointmentId);
  return w.planned.length + w.done.length;
}

export function VisitWork({ appointmentId, onOpenChart }: { appointmentId: string; onOpenChart: () => void }) {
  const { t } = useI18n();
  const store = useOptionalDentalStore();
  if (!store) return null;
  const { planned, done } = workOf(store, appointmentId);
  if (!planned.length && !done.length) return null;
  const open = (markId: string) => () => {
    onOpenChart();
    store.setOpenItem(markId);
  };
  return (
    <div className="grid gap-3 rounded-lg border border-line bg-canvas p-3" data-visit-work={planned.length + done.length}>
      {done.length > 0 && (
        <div className="grid gap-1.5" data-visit-done={done.length}>
          <div className="text-[12px] font-semibold text-ink-500">{t.calendar.doneAtVisit}</div>
          <ul className="grid gap-1.5">
            {done.map((d) => (
              <li key={d.markId}>
                <VisitLineView line={d} onOpen={open(d.markId)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {planned.length > 0 && (
        <div className="grid gap-1.5" data-visit-planned={planned.length}>
          <div className="text-[12px] font-semibold text-ink-500">{t.calendar.plannedTreatment}</div>
          <ul className="grid gap-1.5">
            {planned.map((m) => (
              <li key={m.id}>
                <VisitLineView line={{ markId: m.id, site: m.site, label: m.label, labelAr: m.labelAr, treatmentKey: m.treatmentKey, steps: [] }} onOpen={open(m.id)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
