"use client";

/*
  Finishing a visit, and handing it to the desk.

  Finish used to end the visit and say nothing: reception guessed what to bill
  and when the patient should come back, and Book next opened an hour from now.
  Here the doctor says it once, in the room — when the next visit should be,
  how long and with whom, and a line for reception — and the desk is told.

  Everything on it is optional, and Skip finishes the visit exactly as it used
  to (Yamen, 2026-10-31). Most doctors use it on their phone between patients,
  so it rises from the bottom of a phone with the answers as big chips, and
  sits as a small dialog on a wider screen.
*/

import { useState } from "react";
import { createPortal } from "react-dom";
import { CheckCheck, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { VisitLineView } from "@/components/charts/dental/visit-work";
import type { VisitLine } from "@/lib/charts/dental/treatment";
import type { Handoff } from "@/app/c/[slug]/calendar/flow-actions";

/** In how many days, as a doctor says it: a week, two, a month, three, six. */
export const NEXT_VISIT_CHOICES = [7, 14, 30, 90, 182] as const;
const LENGTHS = [15, 20, 30, 45, 60, 90, 120];

export function FinishVisitSheet({
  patientName,
  serviceName,
  done = [],
  doctors = [],
  defaultDoctorId,
  defaultMinutes,
  busy,
  onFinish,
  onClose,
}: {
  patientName: string;
  serviceName: string | null;
  /** What the chart recorded at this visit. */
  done?: VisitLine[];
  /** Who the next visit can be with; with one or none the choice is not shown. */
  doctors?: { id: string; name: string }[];
  defaultDoctorId: string | null;
  /** The booked service's length. */
  defaultMinutes: number | null;
  busy: boolean;
  /** Null is Skip: finished, nothing handed on. */
  onFinish: (handoff: Handoff | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const F = t.finishVisit;
  const [days, setDays] = useState<number | null>(null);
  const [none, setNone] = useState(false);
  const [minutes, setMinutes] = useState<number>(defaultMinutes && LENGTHS.includes(defaultMinutes) ? defaultMinutes : 30);
  const [doctorId, setDoctorId] = useState<string>(defaultDoctorId ?? "");
  const [note, setNote] = useState("");

  const chip = (on: boolean) =>
    `h-11 touch-manipulation rounded-full border px-4 text-[14px] font-semibold transition-colors duration-100 ${
      on ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line-strong bg-surface text-ink-700 hover:bg-sunken"
    }`;

  const finish = () =>
    onFinish({
      nextDays: days,
      nextMin: days ? minutes : null,
      nextMemberId: days && doctorId ? doctorId : null,
      note,
    });

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={F.title} data-finish-sheet>
      <button type="button" aria-label={t.common.close} onClick={onClose} className="absolute inset-0 bg-night/35 animate-fade-in" />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl bg-surface shadow-pop animate-fade-up md:inset-x-auto md:bottom-auto md:left-1/2 md:top-[10vh] md:w-full md:max-w-lg md:-translate-x-1/2 md:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold">{F.title}</h2>
            <p className="truncate text-[13px] text-ink-500">
              {patientName}
              {serviceName ? ` · ${serviceName}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label={t.common.close} className="-me-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-5 overflow-y-auto overscroll-contain px-5 py-4">
          {done.length > 0 && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">{F.doneToday}</h3>
              <div className="grid gap-1.5 rounded-lg bg-canvas p-2">
                {done.map((l) => (
                  <VisitLineView key={l.markId} line={l} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">{F.nextVisit}</h3>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={F.nextVisit}>
              {NEXT_VISIT_CHOICES.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={days === d}
                  onClick={() => {
                    setDays(days === d ? null : d);
                    setNone(false);
                  }}
                  className={chip(days === d)}
                  data-next-days={d}
                >
                  {F.inDays[String(d) as keyof typeof F.inDays]}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={none}
                onClick={() => {
                  setNone(!none);
                  setDays(null);
                }}
                className={chip(none)}
                data-next-days="none"
              >
                {F.noneNeeded}
              </button>
            </div>
            {days && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-ink-500">{F.length}</span>
                  <select
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                    className="h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm"
                    data-next-minutes
                  >
                    {LENGTHS.map((m) => (
                      <option key={m} value={m}>
                        {F.minutes.replace("{n}", String(m))}
                      </option>
                    ))}
                  </select>
                </label>
                {doctors.length > 1 && (
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-semibold text-ink-500">{F.with}</span>
                    <select
                      value={doctorId}
                      onChange={(e) => setDoctorId(e.target.value)}
                      className="h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm"
                    >
                      <option value="">{F.anyDoctor}</option>
                      {doctors.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </section>

          <label className="block">
            <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">{F.noteForDesk}</span>
            <textarea
              dir="auto"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={F.notePlaceholder}
              className="w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base focus:border-brand-600 focus:outline-none md:text-sm"
              data-desk-note
            />
          </label>
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <Button variant="ghost" size="lg" onClick={() => onFinish(null)} disabled={busy} data-finish-skip>
            {F.skip}
          </Button>
          <Button size="lg" className="flex-1" onClick={finish} loading={busy} data-finish-confirm>
            <CheckCheck className="h-4 w-4" />
            {F.finish}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
