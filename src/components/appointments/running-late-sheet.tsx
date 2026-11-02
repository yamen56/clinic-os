"use client";

/*
  A patient running late (Yamen, 2026-11-02).

  Reception says how many minutes — a chip for the usual answers, a box for
  any other — and, if it chooses, tells the patients booked after them with
  the same doctor that their appointment may start a little late. Telling is
  optional: "Save only" writes the minutes on the board and sends nothing.
  Nobody's booking moves.

  The patients already in the clinic are not listed (they can see the wait),
  nor anyone with no phone to message; someone already told today is listed
  but left unticked, so nobody gets the same message twice by accident.
*/

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Clock, MessageCircle, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";

const CHOICES = [5, 10, 15, 20, 30, 45, 60];

export type LateNext = { id: string; name: string; time: string; toldAt: string | null; hasPhone: boolean };

export function RunningLateSheet({
  patientName,
  time,
  defaultMinutes,
  next,
  busy,
  onSave,
  onClose,
}: {
  patientName: string;
  /** Their booked time, as the board shows it. */
  time: string;
  defaultMinutes: number;
  /** The doctor's patients after this one today, not in the clinic yet. */
  next: LateNext[];
  busy: boolean;
  onSave: (minutes: number, tellIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const L = t.runningLate;
  const [minutes, setMinutes] = useState(defaultMinutes);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(next.filter((n) => n.hasPhone && !n.toldAt).map((n) => n.id)));
  const tell = useMemo(() => next.filter((n) => picked.has(n.id) && n.hasPhone).map((n) => n.id), [next, picked]);
  const ok = Number.isFinite(minutes) && minutes >= 1 && minutes <= 240;

  const chip = (on: boolean) =>
    `h-11 min-w-14 touch-manipulation rounded-full border px-3.5 text-[14px] font-semibold tnum transition-colors duration-100 ${
      on ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line-strong bg-surface text-ink-700 hover:bg-sunken"
    }`;

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={L.title} data-late-sheet>
      <button type="button" aria-label={t.common.close} onClick={onClose} className="absolute inset-0 bg-night/35 animate-fade-in" />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl bg-surface shadow-pop animate-fade-up md:inset-x-auto md:bottom-auto md:left-1/2 md:top-[10vh] md:w-full md:max-w-lg md:-translate-x-1/2 md:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold">{L.title}</h2>
            <p className="truncate text-[13px] text-ink-500">
              {patientName} · <span className="tnum">{time}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label={t.common.close} className="-me-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-5 overflow-y-auto overscroll-contain px-5 py-4">
          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">{L.howLate}</h3>
            <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={L.howLate}>
              {CHOICES.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={minutes === m} onClick={() => setMinutes(m)} className={chip(minutes === m)} data-late-minutes={m}>
                  {L.minutes.replace("{n}", String(m))}
                </button>
              ))}
              <label className="inline-flex items-center gap-2">
                <span className="sr-only">{L.custom}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={240}
                  value={Number.isFinite(minutes) ? minutes : ""}
                  onChange={(e) => setMinutes(e.target.value === "" ? NaN : Math.round(Number(e.target.value)))}
                  className="h-11 w-20 rounded-ctl border border-line bg-surface px-3 text-center text-base tnum md:text-sm"
                  aria-label={L.custom}
                  data-late-custom
                />
              </label>
            </div>
          </section>

          <section>
            <div className="mb-1 flex items-baseline gap-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-400">{L.tellTitle}</h3>
              <span className="text-[12px] text-ink-400">{L.tellOptional}</span>
            </div>
            {next.length === 0 ? (
              <p className="text-[13px] text-ink-500" data-late-nobody>
                {L.nobodyAfter}
              </p>
            ) : (
              <>
                <p className="mb-2 text-[13px] text-ink-500">{L.tellHint.replace("{n}", ok ? String(minutes) : "…")}</p>
                <ul className="overflow-hidden rounded-ctl border border-line">
                  {next.map((n) => (
                    <li key={n.id} className="border-t border-line first:border-t-0">
                      <label className={`flex min-h-12 items-center gap-3 px-3 py-2 ${n.hasPhone ? "cursor-pointer" : "opacity-60"}`} data-late-next={n.id}>
                        <input
                          type="checkbox"
                          className="h-5 w-5 shrink-0 accent-brand-600"
                          disabled={!n.hasPhone}
                          checked={n.hasPhone && picked.has(n.id)}
                          onChange={() =>
                            setPicked((prev) => {
                              const s = new Set(prev);
                              if (s.has(n.id)) s.delete(n.id);
                              else s.add(n.id);
                              return s;
                            })
                          }
                        />
                        <span className="w-12 shrink-0 text-[13px] font-semibold tnum">{n.time}</span>
                        <span className="min-w-0 flex-1 truncate text-[14px]">{n.name}</span>
                        {!n.hasPhone ? (
                          <span className="shrink-0 text-[12px] text-ink-400">{L.noPhone}</span>
                        ) : n.toldAt ? (
                          <span className="shrink-0 text-[12px] text-ink-500 tnum">{L.toldAt.replace("{time}", n.toldAt)}</span>
                        ) : null}
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          {tell.length > 0 ? (
            <>
              <Button variant="ghost" size="lg" onClick={() => onSave(minutes, [])} disabled={busy || !ok} data-late-save-only>
                {L.saveOnly}
              </Button>
              <Button size="lg" className="flex-1" onClick={() => onSave(minutes, tell)} loading={busy} disabled={!ok} data-late-tell>
                <MessageCircle className="h-4 w-4" />
                {L.saveAndTell.replace("{n}", String(tell.length))}
              </Button>
            </>
          ) : (
            <Button size="lg" className="flex-1" onClick={() => onSave(minutes, [])} loading={busy} disabled={!ok} data-late-save-only>
              <Clock className="h-4 w-4" />
              {L.save}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
