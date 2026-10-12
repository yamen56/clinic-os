"use client";

/*
  The tooth in the doctor's hand.

  Two sizes.

  The compact one opens beside the chart, or docked under it on a tablet or a
  phone: a small copy of the tooth with its surfaces on one line, what is
  still to be done on it, then how and who, then the treatments to choose
  from, then what is already there.

  The full view is the tooth's own window — Yamen: "I want to see what I need
  to do with it, not just in a small screen; the full view of everything".
  It opens on the tooth, not on the list of treatments: the tooth drawn big,
  what is to be done on it with the next step of each, what was done and what
  it came with, its findings, x-rays, notes and history. The treatments are
  one button away (Add treatment), a treatment's steps open in the same
  window, and the arrows walk to the next tooth without closing it. Which size
  opens is the doctor's choice, and is remembered.

  Either way the drawing changes the moment a treatment is chosen, so the
  panel and the chart agree at every tap.
*/

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Image as ImageIcon, Maximize2, Minimize2, Plus, Siren, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { ChartImage } from "./image-viewer";
import { AddImageButtons, ImageThumb } from "./image-strip";
import { findTreatment, type Treatment } from "@/lib/charts/dental/catalog";
import { SURFACES, surfaceAt, surfaceLabel, tooth as toothOf, toothName, type Surface } from "@/lib/charts/dental/teeth";
import { paintAt, stateOf, type Mark, type MarkEvent, type Paint, type Person, type Status, type ToothState } from "@/lib/charts/dental/state";
import { OCC, SIDE_H, ToothSide, ToothTop, INK, SOFT, PaintSwatch } from "./tooth-art";
import { TreatmentGlyph, TreatmentPicker, type Favorite } from "./treatment-picker";
import { EntryRow, EventList, PaintPill } from "./history";
import { markLabel, siteLabel } from "./labels";

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
  /** Open these images in the viewer, at this one. */
  onOpenImages: (list: ChartImage[], index: number) => void;
  onPinImage: (imageId: string, fdi: string) => void;
  onUploadForTooth: (kind: "xray" | "photo", f: File, fdi: string) => void;
  /** Arm the imaging station for this tooth. */
  onTakeXray: (fdi: string) => void;
  /** A photo of this tooth from a camera on this device. */
  onCamera: (fdi: string) => void;
  /** Open an entry that is not on this tooth — the full arch a tooth's implant belongs to. */
  onOpenEntry: (id: string) => void;
  /** Open a treatment's steps. */
  onOpenItem: (id: string) => void;
  onClose: () => void;
};

export type PanelSize = "compact" | "big";

const STATUSES: Status[] = ["planned", "done", "existing"];

function useMinWidth(px: number): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setOk(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return ok;
}

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

/** The surfaces as chips: the letter, and the word too where there is room for it. */
function SurfaceChips({ fdi, picked, short, onToggle }: { fdi: string; picked: Surface[]; short?: boolean; onToggle: (s: Surface) => void }) {
  const { locale } = useI18n();
  const tt = toothOf(fdi);
  return (
    <div className={`flex flex-wrap gap-1.5 ${short ? "" : "justify-center"}`}>
      {SURFACES.map((s) => {
        const on = picked.includes(s);
        const l = surfaceLabel(tt, s, locale);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onToggle(s)}
            aria-pressed={on}
            title={l.long}
            aria-label={short ? l.long : undefined}
            data-surface-chip={s}
            className={`h-9 rounded-ctl border text-[12.5px] font-semibold transition-colors duration-140 ${short ? "min-w-9 px-2" : "px-2.5"} ${
              on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
            }`}
          >
            <span className="latin">{l.short}</span>
            {!short && <span className={`ms-1 font-normal ${on ? "text-white/80" : "text-ink-500"}`}>{l.long}</span>}
          </button>
        );
      })}
    </div>
  );
}

/*
  The compact tooth: side and top a third of the size, the surfaces beside
  them as letters. The whole strip is one line, so what comes after starts
  where the big drawing used to end.
*/
function CompactTooth({ fdi, st, picked, flash, hint, onToggle }: { fdi: string; st: ToothState; picked: Surface[]; flash: boolean; hint: string; onToggle: (s: Surface) => void }) {
  const t = toothOf(fdi);
  return (
    <div className="rounded-card bg-canvas px-3 py-2" data-compact-tooth>
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-2" dir="ltr">
          <svg viewBox={`0 0 44 ${SIDE_H}`} className="h-16 w-auto" aria-hidden>
            <ToothSide t={t} st={st} uid="pc" />
          </svg>
          <svg viewBox="-8 -8 60 60" className={`h-16 w-16 rounded-xl ${flash ? "animate-pulse ring-2 ring-dental-planned" : ""}`} role="group">
            <ToothTop t={t} st={st} uid="pc" picked={picked} onSurface={(s) => onToggle(s)} />
          </svg>
        </div>
        {!st.gone && (
          <div className="min-w-0 flex-1">
            <SurfaceChips fdi={fdi} picked={picked} short onToggle={onToggle} />
          </div>
        )}
      </div>
      {/* Said only when it matters: the treatment needs surfaces and none are chosen. */}
      {flash && <p className="mt-1.5 text-[12px] font-semibold text-danger">{hint}</p>}
    </div>
  );
}

/** A section heading with a count, and room for an action at the end. */
function Heading({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h4 className="text-[13px] font-semibold text-ink-900">
        {title}
        {count !== undefined && <span className="ms-1.5 rounded-full bg-sunken px-2 py-0.5 text-[12px] font-semibold text-ink-500 tnum">{count}</span>}
      </h4>
      {children}
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
  canWrite,
  tz,
  images,
  pins,
  uploading,
  parentOf,
  parentName,
  progressFor,
  size = "compact",
  onSize,
  card,
  neighbours,
  onGoTooth,
  onEmergency,
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
  /** May this member record on the chart? Without it, everything reads and nothing writes. */
  canWrite: boolean;
  tz: string;
  /** Every x-ray and photo of the patient, and which teeth each is pinned to. */
  images: ChartImage[];
  pins: Record<string, string[]>;
  uploading: boolean;
  /** The full arch an entry on this tooth is part of, if it is one of its teeth. */
  parentOf: (m: Mark) => Mark | null;
  parentName: (m: Mark) => string;
  /** How far a treatment with steps has come; null for one-tap work. */
  progressFor: (m: Mark) => { done: number; total: number; next: string | null } | null;
  /** Compact beside or under the chart, or the tooth's full view in a window of its own. */
  size?: PanelSize;
  /** Switch between the two; without it the panel stays as it is. */
  onSize?: (s: PanelSize) => void;
  /** In the full view: a treatment's steps, opened from it, shown in its place. */
  card?: React.ReactNode;
  /** The teeth either side, for walking along the arch from the full view. */
  neighbours?: { prev: string | null; next: string | null };
  onGoTooth?: (fdi: string) => void;
  /** An emergency on this tooth. */
  onEmergency?: () => void;
  a: PanelActions;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const big = size === "big";
  const twoColumns = useMinWidth(1024) && big;
  const single = teeth.length === 1 ? teeth[0] : null;
  const st = single ? stateOf(states, single) : null;
  const tt = single ? toothOf(single) : null;
  const here = marks
    .filter((m) => teeth.includes(m.site))
    .sort((x, y) => Number(!!x.voidedAt) - Number(!!y.voidedAt) || Date.parse(y.createdAt) - Date.parse(x.createdAt));
  const hereIds = new Set(here.map((m) => m.id));
  const paint: Paint = status;
  const locked = past || !canWrite;
  const spanName = span ? (locale === "ar" ? span.ar : span.en) : "";
  // This tooth's x-rays and photos, and the patient's others that could be pinned to it.
  const toothImages = single ? images.filter((img) => (pins[img.id] ?? []).includes(single)) : [];
  const otherImages = single ? images.filter((img) => !(pins[img.id] ?? []).includes(single)) : [];

  /*
    What is on the tooth, by what it asks of the doctor: what is still to be
    done (under way first), what was done or came with it, what was found,
    and what was voided.
  */
  const live = here.filter((m) => !m.voidedAt);
  const todo = live.filter((m) => m.kind === "procedure" && m.status === "planned").sort((x, y) => Number(!!y.startedAt) - Number(!!x.startedAt));
  const doneList = live.filter((m) => m.kind === "procedure" && m.status !== "planned");
  const findings = live.filter((m) => m.kind !== "procedure");
  const voided = here.filter((m) => !!m.voidedAt);

  // The full view opens on the tooth; the treatments are a pane of their own.
  const [pane, setPane] = useState<"tooth" | "add">("tooth");
  const toothKey = teeth.join(",");
  const count = here.length;
  const lastCount = useRef(count);
  useEffect(() => {
    setPane("tooth");
    lastCount.current = count;
    // Only a different tooth resets the pane; its count moves with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toothKey]);
  // A treatment added from the list: back to the tooth, where it now is.
  useEffect(() => {
    if (count > lastCount.current && pane === "add") setPane("tooth");
    lastCount.current = count;
  }, [count, pane]);

  // Walking along the arch from the full view: the arrow keys, as on the chart.
  useEffect(() => {
    if (!big || !single || !neighbours || !onGoTooth) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const next = e.key === "ArrowLeft" ? neighbours.prev : e.key === "ArrowRight" ? neighbours.next : null;
      if (!next) return;
      e.preventDefault();
      onGoTooth(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big, single, neighbours, onGoTooth]);

  const sizeButton = onSize && (
    <button
      type="button"
      onClick={() => onSize(big ? "compact" : "big")}
      aria-pressed={big}
      aria-label={big ? T.panelSmaller : T.panelBigger}
      title={big ? T.panelSmaller : T.panelBigger}
      data-expand-panel={big ? "big" : "compact"}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-ctl border border-line bg-surface px-2.5 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken"
    >
      {big ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      <span className="hidden sm:inline">{big ? T.panelSmaller : T.panelBigger}</span>
    </button>
  );
  const closeButton = (
    <button type="button" onClick={a.onClose} aria-label={T.close} className="grid h-9 w-9 shrink-0 place-items-center rounded-ctl text-ink-500 hover:bg-sunken">
      <X className="h-4.5 w-4.5" />
    </button>
  );
  const imagesChip = toothImages.length > 0 && (
    <button
      type="button"
      onClick={() => a.onOpenImages(toothImages, 0)}
      data-open-tooth-images
      className="mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 text-[12px] font-semibold text-brand-700 hover:bg-brand-100"
    >
      <ImageIcon className="h-3.5 w-3.5" />
      {T.imagesOfTooth} · {toothImages.length}
    </button>
  );
  const badges = (
    <div className="flex flex-wrap gap-1">
      {teeth.map((f) => (
        <span key={f} className="grid h-11 min-w-11 place-items-center rounded-xl bg-brand-600 px-2 font-display text-lg font-bold text-white tnum">
          {f}
        </span>
      ))}
    </div>
  );
  const name = tt ? toothName(tt, locale) : T.teeth.replace("{list}", teeth.join(" · "));

  const spanBox = span && (
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
  );

  // The big drawing where there is room for it; the one-line tooth everywhere else.
  const toothBlock =
    single && st ? (
      twoColumns ? (
        <div className="rounded-card bg-canvas px-3 py-4">
          <BigTooth fdi={single} st={st} picked={picked} flash={flash} onToggle={a.onTogglePicked} />
          {tt && !st.gone && (
            <div className="mt-3">
              <div className={`mb-1.5 text-center text-[12px] font-semibold ${flash ? "text-danger" : "text-ink-500"}`}>{T.surfacesHint}</div>
              <SurfaceChips fdi={single} picked={picked} onToggle={a.onTogglePicked} />
            </div>
          )}
        </div>
      ) : (
        <CompactTooth fdi={single} st={st} picked={picked} flash={flash} hint={T.surfacesHint} onToggle={a.onTogglePicked} />
      )
    ) : null;

  const controls = locked ? (
    <p className="rounded-ctl bg-sunken px-3 py-2 text-[13px] text-ink-700" data-read-only>{past ? T.readOnlyPast : T.readOnly}</p>
  ) : (
    /* "How" and "who", in one line: then straight to the treatments. */
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex shrink-0 rounded-ctl bg-sunken p-0.5" role="radiogroup">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={status === s}
            title={T.statusHint[s]}
            onClick={() => a.onStatus(s)}
            className="inline-flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-semibold transition-colors duration-140"
            style={status === s ? { background: SOFT[s], color: INK[s], boxShadow: "var(--shadow-card)" } : { color: "var(--color-ink-500)" }}
          >
            <PaintSwatch paint={s} size={14} />
            {T.status[s]}
          </button>
        ))}
      </div>
      <label className="flex min-w-[11rem] flex-1 items-center gap-2">
        <span className="shrink-0 text-[12px] font-semibold text-ink-500">{T.performedBy}</span>
        <select
          value={performer}
          onChange={(e) => a.onPerformer(e.target.value)}
          className="select-chevron h-9 min-w-0 flex-1 appearance-none rounded-ctl border border-line bg-surface ps-3 pe-8 text-base md:text-sm"
        >
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  const picker = !locked && (
    <section>
      <TreatmentPicker
        catalog={catalog}
        context={tt}
        favorites={favorites}
        recent={recent}
        paint={paint}
        tz={tz}
        wide={big}
        onPick={a.onPick}
        onToggleFavorite={a.onToggleFavorite}
        onAddCustom={a.onAddCustom}
      />
    </section>
  );

  /*
    One entry. A tooth of a full arch is done, voided and noted as the whole,
    so it points there rather than offering its own controls.
  */
  const entry = (m: Mark) => {
    const parent = parentOf(m);
    if (parent) {
      return (
        <li key={m.id} className={`flex items-center gap-2.5 rounded-ctl border border-line bg-surface p-2.5 ${m.voidedAt ? "opacity-60" : ""}`} data-mark={m.id} data-part-of={parent.id}>
          <TreatmentGlyph tr={findTreatment(m.treatmentKey, custom) ?? { key: m.treatmentKey, kind: m.kind, category: "implant", en: m.label, ar: m.labelAr, scope: "tooth", look: m.look }} paint={paintAt(m, null) ?? "existing"} context={tt} size={42} />
          <div className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`text-[13.5px] font-semibold text-ink-900 ${m.voidedAt ? "line-through" : ""}`}>{markLabel(m, locale)}</span>
              <PaintPill m={m} />
            </span>
            <span className="mt-0.5 block text-[12px] text-ink-500">{T.partOf.replace("{name}", `${parentName(parent)} · ${siteLabel(parent.site, T)}`)}</span>
          </div>
          <button
            type="button"
            onClick={() => a.onOpenEntry(parent.id)}
            className="h-8 shrink-0 rounded-ctl border border-line bg-surface px-2.5 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken"
          >
            {T.openWhole}
          </button>
        </li>
      );
    }
    return (
      <EntryRow
        key={m.id}
        m={m}
        custom={custom}
        doctors={doctors}
        tz={tz}
        canEdit={!locked}
        onMarkDone={a.onMarkDone}
        onVoid={a.onVoid}
        onNote={a.onNote}
        onDetail={a.onDetail}
        onPerformer={a.onEntryPerformer}
        progress={progressFor(m)}
        onOpen={progressFor(m) ? () => a.onOpenItem(m.id) : undefined}
      />
    );
  };
  const list = (ms: Mark[]) => <ul className="grid gap-2">{ms.map(entry)}</ul>;

  const todoSection = todo.length > 0 && (
    <section data-tooth-todo={todo.length}>
      <Heading title={T.todoTitle} count={todo.length} />
      {list(todo)}
    </section>
  );
  const doneSection = doneList.length > 0 && (
    <section data-tooth-done={doneList.length}>
      <Heading title={T.doneTitle} count={doneList.length} />
      {list(doneList)}
    </section>
  );
  const findingsSection = findings.length > 0 && (
    <section data-tooth-findings={findings.length}>
      <Heading title={T.findingsTitle} count={findings.length} />
      {list(findings)}
    </section>
  );
  const voidedSection = voided.length > 0 && (
    <details className="rounded-ctl border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer list-none py-1 text-[13px] font-semibold text-ink-500">
        {T.voidedTitle} <span className="tnum">· {voided.length}</span>
      </summary>
      <div className="pt-2">{list(voided)}</div>
    </details>
  );

  const imageSection = single && (
    <section data-tooth-image-section>
      <h4 className="mb-2 text-[13px] font-semibold text-ink-900">
        {T.imagesOfTooth}
        {toothImages.length > 0 && <span className="ms-1 rounded-full bg-sunken px-2 py-0.5 text-[12px] text-ink-500 tnum">{toothImages.length}</span>}
      </h4>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {toothImages.map((img, i) => (
          <ImageThumb key={img.id} img={img} pinned={pins[img.id] ?? []} size="sm" onOpen={() => a.onOpenImages(toothImages, i)} />
        ))}
        {!past && (
          <AddImageButtons
            compact
            busy={uploading}
            onFile={(k, f) => a.onUploadForTooth(k, f, single)}
            onTakeXray={canWrite ? () => a.onTakeXray(single) : undefined}
            onCamera={() => a.onCamera(single)}
          />
        )}
      </div>
      {!locked && otherImages.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12.5px] font-semibold text-brand-600">{T.pinImage}</summary>
          <div className="-mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1">
            {otherImages.map((img) => (
              <ImageThumb key={img.id} img={img} pinned={pins[img.id] ?? []} size="sm" onOpen={() => a.onPinImage(img.id, single)} />
            ))}
          </div>
        </details>
      )}
    </section>
  );

  const history = (
    <details className="group rounded-ctl border border-line bg-surface px-3 py-2" open={past}>
      <summary className="cursor-pointer list-none py-1 text-[13px] font-semibold text-ink-900">{T.toothHistory}</summary>
      <div className="pt-2">
        <EventList events={events.filter((e) => hereIds.has(e.markId))} marks={marks} tz={tz} />
      </div>
    </details>
  );

  if (!big) {
    // Compact: what is still to be done comes before the list of treatments.
    return (
      <div className="flex flex-col gap-4" data-panel-size="compact">
        <div className="flex items-start gap-3">
          {badges}
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[15px] font-semibold leading-tight text-ink-900">{name}</div>
            {imagesChip}
          </div>
          {sizeButton}
          {closeButton}
        </div>
        {spanBox}
        {toothBlock}
        {todoSection}
        {controls}
        {picker}
        {doneSection}
        {findingsSection}
        {voidedSection}
        {imageSection}
        {history}
      </div>
    );
  }

  /* ── The tooth's full view ─────────────────────────────────────────── */
  const summary = [
    todo.length ? T.summaryTodo.replace("{n}", String(todo.length)) : null,
    doneList.length ? T.summaryDone.replace("{n}", String(doneList.length)) : null,
    findings.length ? T.summaryFindings.replace("{n}", String(findings.length)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // On a phone the actions take a row of their own under the name, so the name is not squeezed into three lines.
  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {badges}
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-semibold leading-tight text-ink-900">{name}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-500" data-tooth-summary>
          {summary || T.nothingOnTooth}
        </div>
      </div>
      <div className="sm:order-last">{closeButton}</div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      {single && neighbours && onGoTooth && (
        <div className="inline-flex items-center gap-1" dir="ltr">
          <button
            type="button"
            disabled={!neighbours.prev}
            onClick={() => neighbours.prev && onGoTooth(neighbours.prev)}
            aria-label={T.prevTooth}
            title={T.prevTooth}
            className="inline-flex h-9 items-center gap-0.5 rounded-ctl border border-line bg-surface px-2 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken disabled:opacity-40"
            data-go-tooth="prev"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="tnum">{neighbours.prev ?? ""}</span>
          </button>
          <button
            type="button"
            disabled={!neighbours.next}
            onClick={() => neighbours.next && onGoTooth(neighbours.next)}
            aria-label={T.nextTooth}
            title={T.nextTooth}
            className="inline-flex h-9 items-center gap-0.5 rounded-ctl border border-line bg-surface px-2 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken disabled:opacity-40"
            data-go-tooth="next"
          >
            <span className="tnum">{neighbours.next ?? ""}</span>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
      {onEmergency && !locked && (
        <button
          type="button"
          onClick={onEmergency}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-ctl border border-danger/30 bg-danger-soft px-2.5 text-[12.5px] font-semibold text-danger hover:bg-danger/10"
          data-tooth-emergency
        >
          <Siren className="h-4 w-4" />
          <span className="hidden sm:inline">{T.treatment.emergency}</span>
        </button>
      )}
      {sizeButton}
      </div>
    </div>
  );

  // Common treatments, one tap away, without the whole list: the clinic's favourites, then this doctor's recent ones.
  const byKey = new Map(catalog.map((tr) => [tr.key, tr]));
  const quick = [...favorites.map((f) => f.key), ...recent]
    .filter((k, i, all) => all.indexOf(k) === i)
    .map((k) => byKey.get(k))
    .filter((tr): tr is Treatment => !!tr)
    .slice(0, 8);
  const addButton = !locked && (
    <button
      type="button"
      onClick={() => setPane("add")}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-ctl bg-brand-600 px-3 text-[13px] font-semibold text-white hover:bg-brand-700"
      data-add-treatment
    >
      <Plus className="h-4 w-4" />
      {T.addTreatment}
    </button>
  );
  const quickRow = !locked && quick.length > 0 && (
    <section data-quick-add>
      <Heading title={T.quickAdd} />
      <div className="flex flex-wrap gap-1.5">
        {quick.map((tr) => (
          <button
            key={tr.key}
            type="button"
            onClick={() => a.onPick(tr)}
            className="inline-flex h-10 items-center gap-2 rounded-ctl border border-line bg-surface ps-1.5 pe-3 text-[13px] font-semibold text-ink-900 hover:border-line-strong hover:bg-brand-50"
            data-quick-treatment={tr.key}
          >
            <TreatmentGlyph tr={tr} paint={tr.kind === "finding" ? "finding" : paint} context={tt} size={26} />
            {locale === "ar" ? tr.ar : tr.en}
          </button>
        ))}
      </div>
    </section>
  );

  // What the right side shows: a treatment's steps, the list of treatments, or the tooth.
  const adding = pane === "add" || !single || !!span;
  const main = card ? (
    <div className="min-w-0" data-tooth-pane="card">
      {card}
    </div>
  ) : adding ? (
    <div className="grid gap-4" data-tooth-pane="add">
      {single && !span && (
        <button type="button" onClick={() => setPane("tooth")} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-ink-500 hover:text-ink-900" data-back-to-tooth>
          <ArrowLeft className="h-4 w-4" />
          {T.backToTooth.replace("{n}", single)}
        </button>
      )}
      {spanBox}
      {controls}
      {picker}
    </div>
  ) : (
    <div className="grid gap-5" data-tooth-pane="tooth">
      <section data-tooth-todo={todo.length}>
        <Heading title={T.todoTitle} count={todo.length}>
          {addButton}
        </Heading>
        {todo.length ? list(todo) : <p className="rounded-ctl border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-500">{T.nothingToDo}</p>}
      </section>
      {quickRow && (
        <div className="grid gap-2">
          {controls}
          {quickRow}
        </div>
      )}
      {doneSection}
      {findingsSection}
      {voidedSection}
    </div>
  );

  if (twoColumns) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-dental-panel="" data-panel-size="big">
        <div className="border-b border-line px-5 py-3">{header}</div>
        <div className="flex min-h-0 flex-1">
          {/* minmax(0, 1fr): a grid track sized by its widest child grew past the column and scrolled it sideways. */}
          <aside className="grid w-[360px] shrink-0 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto overflow-x-hidden border-e border-line p-4">
            {toothBlock}
            {imageSection}
            {history}
          </aside>
          <section className="min-w-0 flex-1 overflow-y-auto p-5">{main}</section>
        </div>
      </div>
    );
  }

  // On a phone or an upright tablet: the whole screen, one column, the tooth first.
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-dental-panel="" data-panel-size="big">
      <div className="border-b border-line px-4 py-3">{header}</div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto overflow-x-hidden p-4">
        {toothBlock}
        {main}
        {imageSection}
        {history}
      </div>
    </div>
  );
}
