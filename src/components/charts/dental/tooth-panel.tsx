"use client";

/*
  The tooth in the doctor's hand.

  A large copy of the selected tooth — side and top — that changes the moment a
  treatment is chosen, so the panel and the chart behind it agree at every tap.
  Then the surfaces, the status and the doctor; then what is already on the
  tooth; then the treatments to choose from; then the tooth's history.
*/

import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Treatment } from "@/lib/charts/dental/catalog";
import { SURFACES, surfaceAt, surfaceLabel, tooth as toothOf, toothName, type Surface } from "@/lib/charts/dental/teeth";
import { stateOf, type Mark, type MarkEvent, type Paint, type Person, type Status, type ToothState } from "@/lib/charts/dental/state";
import { OCC, SIDE_H, ToothSide, ToothTop, INK, SOFT } from "./tooth-art";
import { TreatmentPicker, type Favorite } from "./treatment-picker";
import { EntryRow, EventList } from "./history";

export type PanelActions = {
  onTogglePicked: (s: Surface) => void;
  onStatus: (s: Status) => void;
  onPerformer: (id: string) => void;
  onPick: (tr: Treatment) => void;
  onToggleFavorite: (key: string) => void;
  onAddCustom: () => void;
  onSpanRecord: () => void;
  onSpanCancel: () => void;
  onMarkDone: (id: string) => void;
  onVoid: (m: Mark) => void;
  onNote: (id: string, note: string) => void;
  onDetail: (id: string, key: string, value: string) => void;
  onEntryPerformer: (id: string, personId: string) => void;
  onClose: () => void;
};

const STATUSES: Status[] = ["planned", "done", "existing"];

function BigTooth({ fdi, st, picked, flash, onToggle }: { fdi: string; st: ToothState; picked: Surface[]; flash: boolean; onToggle: (s: Surface) => void }) {
  const { locale } = useI18n();
  const t = toothOf(fdi);
  const label = (r: "top" | "bottom" | "left" | "right") => surfaceLabel(t, surfaceAt(t, r), locale).short;
  return (
    <div className="flex items-center justify-center gap-4" dir="ltr">
      <svg viewBox={`0 0 44 ${SIDE_H}`} className="h-44 w-auto shrink-0" aria-hidden>
        <ToothSide t={t} st={st} uid="pn" />
      </svg>
      <svg viewBox="-8 -8 60 60" className={`h-40 w-40 shrink-0 rounded-2xl ${flash ? "animate-pulse ring-2 ring-dental-planned" : ""}`} role="group">
        <ToothTop t={t} st={st} uid="pn" picked={picked} onSurface={(s) => onToggle(s)} />
        <g className="fill-ink-500" fontSize={6} fontWeight={700} textAnchor="middle" style={{ fontFamily: "var(--font-sans)" }}>
          <text x={OCC / 2} y={-3}>{label("top")}</text>
          <text x={OCC / 2} y={OCC + 7.5}>{label("bottom")}</text>
          <text x={-5} y={OCC / 2 + 2}>{label("left")}</text>
          <text x={OCC + 5} y={OCC / 2 + 2}>{label("right")}</text>
        </g>
      </svg>
    </div>
  );
}

export function ToothPanel({
  teeth,
  states,
  marks,
  events,
  custom,
  catalog,
  favorites,
  recent,
  picked,
  flash,
  status,
  performer,
  doctors,
  span,
  past,
  tz,
  a,
}: {
  teeth: string[];
  states: Map<string, ToothState>;
  marks: Mark[];
  events: MarkEvent[];
  custom: Treatment[];
  catalog: Treatment[];
  favorites: Favorite[];
  recent: string[];
  picked: Surface[];
  /** The surfaces were needed and not chosen: draw the eye to them. */
  flash: boolean;
  status: Status;
  performer: string;
  doctors: Person[];
  span: Treatment | null;
  /** Looking at an earlier day: everything reads, nothing writes. */
  past: boolean;
  tz: string;
  a: PanelActions;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const single = teeth.length === 1 ? teeth[0] : null;
  const st = single ? stateOf(states, single) : null;
  const tt = single ? toothOf(single) : null;
  const here = marks
    .filter((m) => teeth.includes(m.site))
    .sort((x, y) => Number(!!x.voidedAt) - Number(!!y.voidedAt) || Date.parse(y.createdAt) - Date.parse(x.createdAt));
  const hereIds = new Set(here.map((m) => m.id));
  const paint: Paint = status;
  const spanName = span ? (locale === "ar" ? span.ar : span.en) : "";

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex flex-wrap gap-1">
          {teeth.map((f) => (
            <span key={f} className="grid h-11 min-w-11 place-items-center rounded-xl bg-brand-600 px-2 font-display text-lg font-bold text-white tnum">
              {f}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          {tt ? (
            <>
              <div className="text-[15px] font-semibold leading-tight text-ink-900">{toothName(tt, locale)}</div>
              <div className="mt-0.5 text-[12px] text-ink-500 latin">{toothName(tt, locale === "ar" ? "en" : "ar")}</div>
            </>
          ) : (
            <div className="text-[15px] font-semibold text-ink-900">{T.teeth.replace("{list}", teeth.join(" · "))}</div>
          )}
        </div>
        <button type="button" onClick={a.onClose} aria-label={T.close} className="grid h-9 w-9 shrink-0 place-items-center rounded-ctl text-ink-500 hover:bg-sunken">
          <X className="h-4.5 w-4.5" />
        </button>
      </div>

      {span && (
        <div className="rounded-ctl border border-brand-200 bg-brand-50 p-3">
          <p className="text-[13px] font-semibold text-ink-900">{T.span.replace("{name}", spanName)}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={teeth.length < 2}
              onClick={a.onSpanRecord}
              className="h-9 rounded-ctl bg-brand-600 px-3 text-[13px] font-semibold text-white disabled:opacity-45"
            >
              {T.spanRecord.replace("{n}", String(teeth.length))}
            </button>
            <button type="button" onClick={a.onSpanCancel} className="h-9 rounded-ctl border border-line bg-surface px-3 text-[13px] font-semibold text-ink-700">
              {T.cancel}
            </button>
          </div>
        </div>
      )}

      {single && st && (
        <div className="rounded-card bg-canvas px-3 py-4">
          <BigTooth fdi={single} st={st} picked={picked} flash={flash} onToggle={a.onTogglePicked} />
          {tt && !st.gone && (
            <div className="mt-3">
              <div className="mb-1.5 text-center text-[12px] font-semibold text-ink-500">{T.surfacesHint}</div>
              <div className="flex flex-wrap justify-center gap-1.5">
                {SURFACES.map((s) => {
                  const on = picked.includes(s);
                  const l = surfaceLabel(tt, s, locale);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => a.onTogglePicked(s)}
                      aria-pressed={on}
                      data-surface-chip={s}
                      className={`h-9 rounded-ctl border px-2.5 text-[12.5px] font-semibold transition-colors duration-140 ${
                        on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                      }`}
                    >
                      <span className="latin">{l.short}</span>
                      <span className={`ms-1 font-normal ${on ? "text-white/80" : "text-ink-500"}`}>{l.long}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {past ? (
        <p className="rounded-ctl bg-sunken px-3 py-2 text-[13px] text-ink-700">{T.readOnlyPast}</p>
      ) : (
        <div className="grid gap-3">
          <div>
            <div className="inline-flex rounded-ctl bg-sunken p-0.5" role="radiogroup">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={status === s}
                  title={T.statusHint[s]}
                  onClick={() => a.onStatus(s)}
                  className="h-9 rounded-[6px] px-3 text-[13px] font-semibold transition-colors duration-140"
                  style={status === s ? { background: SOFT[s], color: INK[s], boxShadow: "var(--shadow-card)" } : { color: "var(--color-ink-500)" }}
                >
                  {T.status[s]}
                </button>
              ))}
            </div>
          </div>
          <label className="block min-w-0">
            <span className="mb-1 block text-[12px] font-semibold text-ink-500">{T.performedBy}</span>
            <select
              value={performer}
              onChange={(e) => a.onPerformer(e.target.value)}
              className="select-chevron h-9 w-full appearance-none rounded-ctl border border-line bg-surface ps-3 pe-8 text-base md:text-sm"
            >
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {here.length > 0 && (
        <section>
          <h4 className="mb-2 text-[13px] font-semibold text-ink-900">{T.onTooth}</h4>
          <ul className="grid gap-2">
            {here.map((m) => (
              <EntryRow
                key={m.id}
                m={m}
                custom={custom}
                doctors={doctors}
                tz={tz}
                canEdit={!past}
                onMarkDone={a.onMarkDone}
                onVoid={a.onVoid}
                onNote={a.onNote}
                onDetail={a.onDetail}
                onPerformer={a.onEntryPerformer}
              />
            ))}
          </ul>
        </section>
      )}

      {!past && (
        <section>
          <TreatmentPicker
            catalog={catalog}
            context={tt}
            favorites={favorites}
            recent={recent}
            paint={paint}
            tz={tz}
            onPick={a.onPick}
            onToggleFavorite={a.onToggleFavorite}
            onAddCustom={a.onAddCustom}
          />
        </section>
      )}

      <details className="group rounded-ctl border border-line bg-surface px-3 py-2" open={past}>
        <summary className="cursor-pointer list-none py-1 text-[13px] font-semibold text-ink-900">{T.toothHistory}</summary>
        <div className="pt-2">
          <EventList events={events.filter((e) => hereIds.has(e.markId))} marks={marks} tz={tz} />
        </div>
      </details>
    </div>
  );
}
