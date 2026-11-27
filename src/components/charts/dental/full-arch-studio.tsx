"use client";

/*
  A whole arch, placed by the doctor.

  It used to be a row of sixteen buttons, one a tooth: an implant was at 15 or
  it was not. A dentist, 2026-11-25: in the real procedure they do not choose a
  tooth — the implant goes where the bone is, a little to the right or the
  left, and leans. So the jaw is drawn, the implants stand in it, and each is
  dragged along it, turned by its tip and sunk deeper, like the plan on an
  x-ray. Under the drawing the same things are buttons, big enough for a thumb,
  for a doctor holding a phone and for the last half millimetre.

  What goes on the implants is chosen here too: a bridge screwed to them — in
  one piece, or split at the joints the doctor taps — or a denture the patient
  takes out; what it is made of, and how far back it reaches.

  The same window opens again later, from the treatment's card, to move what
  was recorded to where it was really placed.
*/

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Plus, RotateCcw, RotateCw, Scissors, Trash2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import type { Treatment } from "@/lib/charts/dental/catalog";
import { tooth, type Arch } from "@/lib/charts/dental/teeth";
import { stateOf, type Mark, type Status, type ToothState } from "@/lib/charts/dental/state";
import { IMPLANT_COUNTS, LAST_TEETH, archTeeth, implantsOf, onImplants, prosthesisSites, standingTeeth } from "@/lib/charts/dental/full-arch";
import {
  DEPTHS,
  DIAMETERS,
  LENGTHS,
  MAX_IMPLANTS,
  MAX_TILT,
  boundedPos,
  clampPlace,
  colOf,
  defaultPlaces,
  inOrder,
  leanOf,
  nextPlace,
  placeOf,
  snapTilt,
  teethAt,
  whereText,
  type Place,
} from "@/lib/charts/dental/implant-place";
import { archKind, cutsDetail, cutsOf } from "@/lib/charts/dental/prosthesis";
import { CW, INK, PaintSwatch, SIDE_H, SOFT, TEXT, ToothSide } from "./tooth-art";
import { ARCH_PLATFORM, ImplantArt, PieceSide, implantOutline, type ImplantTop } from "./prosthesis-art";
import { MM } from "./prosthesis-shape";
import { newId, type ArchDraft } from "./writer";

const STATUSES: Status[] = ["planned", "done", "existing"];
const NUM = 20;
const PAD = 30; // room above the jaw for an implant's turning handle
const FULL_W = 16 * CW;
const NARROW_COLS = 7.6; // what a phone shows of the jaw

/** A stand-in for the new bridge on the teeth it covers; drawn by the bridge itself. */
const COVER = "__new-bridge";
const COVERED = new Set([COVER]);

type Item = Place & { id: string };

export type ArchResult = ArchDraft & { arch: Arch; extract: string[] };

export function FullArchStudio({
  tr,
  initialArch,
  parent,
  states,
  marks,
  status,
  onStatus,
  onSave,
  onCancel,
}: {
  tr: Treatment;
  initialArch: Arch | null;
  /** The arch being adjusted; without it a new one is set up. */
  parent?: Mark;
  states: Map<string, ToothState>;
  marks: Mark[];
  status: Status;
  onStatus: (s: Status) => void;
  onSave: (r: ArchResult) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const T = t.dental;
  const F = T.fullArch;
  const implanted = onImplants(tr.key);
  const editing = !!parent;

  const [arch, setArch] = useState<Arch | null>(parent ? (parent.site as Arch) : initialArch);
  const fresh = useCallback((a: Arch, n: number): Item[] => defaultPlaces(a, n).map((p) => ({ ...p, id: newId() })), []);
  const [items, setItems] = useState<Item[]>(() => {
    if (parent) return implantsOf(parent, marks).map((m) => ({ ...placeOf(m), id: m.id }));
    return initialArch && implanted ? fresh(initialArch, 4) : [];
  });
  // One is in hand from the start, so its handle and its buttons are there to be found.
  const [sel, setSel] = useState<string | null>(() => inOrder(items)[0]?.id ?? null);
  const [extract, setExtract] = useState(true);
  const [kind, setKind] = useState<"fixed" | "removable">(() => (parent ? archKind(parent, implantsOf(parent, marks).length) : "fixed"));
  const materials = tr.details?.find((d) => d.key === "material")?.options ?? [];
  const [material, setMaterial] = useState<string | null>(parent ? (parent.detail.material ?? null) : (materials[0]?.key ?? null));
  const oldTeeth = useMemo(() => (parent ? marks.filter((m) => m.groupId === parent.groupId && !m.voidedAt && m.role === "pontic").map((m) => m.site) : []), [parent, marks]);
  const [last, setLast] = useState<number | null>(() => (oldTeeth.length ? Math.max(...oldTeeth.map((f) => Number(f[1]))) : null));
  const [cuts, setCuts] = useState<Set<number>>(() => (parent ? cutsOf(parent.detail) : new Set()));

  const row = useMemo(() => (arch ? archTeeth(arch) : []), [arch]);
  const reach = last ?? (kind === "fixed" && implanted ? 6 : 7);
  const teeth = useMemo(() => (arch ? prosthesisSites(tr.key, arch, items.length, reach) : []), [arch, tr.key, items.length, reach]);
  const colsOfTeeth = teeth.map(colOf);
  const lo = Math.min(...colsOfTeeth);
  const hi = Math.max(...colsOfTeeth);
  const live = kind === "fixed" ? [...cuts].filter((c) => c >= lo && c < hi) : [];
  const standing = useMemo(() => (arch && !editing ? standingTeeth(arch, states, marks) : []), [arch, editing, states, marks]);
  const planned = editing ? parent.status === "planned" : status === "planned";
  const selected = items.find((i) => i.id === sel) ?? null;
  const ready = !!arch && (!implanted || items.length > 0);

  const chooseArch = (a: Arch) => {
    if (a === arch) return;
    setArch(a);
    setCuts(new Set());
    if (!implanted) return;
    const next = fresh(a, items.length || 4);
    setItems(next);
    setSel(inOrder(next)[0].id);
  };
  const chooseCount = (n: number) => {
    if (!arch) return;
    // The usual places for that many; an implant already recorded keeps being that implant.
    const places = defaultPlaces(arch, n);
    const keep = inOrder(items);
    const next = places.map((p, i) => ({ ...p, id: keep[i]?.id ?? newId() }));
    setItems(next);
    setSel(next[0].id);
    if (!editing && n === 2) setKind("removable");
    if (!editing && n >= 4 && kind === "removable") setKind("fixed");
  };
  const change = useCallback((id: string, patch: Partial<Place>) => {
    setItems((prev) => {
      const index = prev.findIndex((p) => p.id === id);
      if (index < 0) return prev;
      const next = { ...prev[index], ...patch };
      if (patch.pos !== undefined) next.pos = boundedPos(prev, index, patch.pos);
      return prev.map((p, i) => (i === index ? { ...clampPlace(next), id } : p));
    });
  }, []);
  const add = () => {
    const p = nextPlace(items);
    if (!p) return;
    const id = newId();
    setItems((prev) => [...prev, { ...p, id }]);
    setSel(id);
  };
  const remove = (id: string) => {
    const at = inOrder(items).findIndex((p) => p.id === id);
    const rest = inOrder(items).filter((p) => p.id !== id);
    setItems(rest);
    setSel(rest[Math.min(at, rest.length - 1)]?.id ?? null);
  };
  const toggleCut = (c: number) =>
    setCuts((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const save = () => {
    if (!arch || !ready) return;
    onSave({
      arch,
      implants: implanted ? inOrder(items) : [],
      teeth,
      kind: implanted ? kind : "removable",
      material: implanted ? material : null,
      cuts: cutsDetail(live),
      extract: planned && extract && !editing ? standing : [],
    });
  };

  const seg = (on: boolean) => `h-10 min-w-10 rounded-[6px] px-3 text-[0.8125rem] font-semibold transition-colors duration-140 ${on ? "bg-segment text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"}`;
  const ordered = inOrder(items);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-full-arch={tr.key} data-full-arch-mode={editing ? "edit" : "new"}>
      {/* Which arch, and how many. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[1.0625rem] font-semibold text-ink-900">{editing ? F.adjustTitle.replace("{name}", T.sites[parent.site as "upper" | "lower"]) : tr.en}</h2>
          <p className="text-[0.78125rem] text-ink-500">{implanted ? F.hintImplants : F.hintDenture}</p>
        </div>
        <button type="button" onClick={onCancel} aria-label={T.close} className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl text-ink-500 hover:bg-sunken sm:order-last">
          <X className="h-4.5 w-4.5" />
        </button>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto" dir="ltr">
          {!editing && (
            <div className="inline-flex rounded-ctl bg-sunken p-0.5" role="radiogroup" aria-label={F.arch}>
              {(["upper", "lower"] as Arch[]).map((a) => (
                <button key={a} type="button" role="radio" aria-checked={arch === a} aria-pressed={arch === a} onClick={() => chooseArch(a)} data-arch={a} className={seg(arch === a)}>
                  {T.sites[a]}
                </button>
              ))}
            </div>
          )}
          {implanted && arch && (
            <div className="inline-flex items-center rounded-ctl bg-sunken p-0.5" role="radiogroup" aria-label={F.implants}>
              {IMPLANT_COUNTS.map((n) => (
                <button key={n} type="button" role="radio" aria-checked={items.length === n} onClick={() => chooseCount(n)} data-implant-count={n} className={seg(items.length === n)}>
                  {n}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!arch ? (
          <p className="px-5 py-10 text-center text-[0.875rem] text-ink-500">{F.arch}</p>
        ) : (
          <>
            <div className="sticky top-0 z-10 border-b border-line bg-surface">
              <Jaw
                arch={arch}
                row={row}
                states={states}
                own={parent?.groupId ?? null}
                faded={planned && extract && !editing ? standing : []}
                items={ordered}
                teeth={teeth}
                cuts={new Set(live)}
                abutment={kind === "fixed" ? "multi" : "heal"}
                material={implanted ? material : null}
                splittable={implanted && kind === "fixed"}
                sel={sel}
                onSelect={setSel}
                onChange={change}
                onCut={toggleCut}
              />
            </div>

            <div className="grid gap-5 px-4 py-4 sm:px-5 lg:grid-cols-2">
              {implanted && (
                <section className="grid content-start gap-3">
                  <div className="flex flex-wrap items-center gap-1.5" dir="ltr">
                    {ordered.map((p, i) => (
                      <button
                        key={p.id}
                        type="button"
                        aria-pressed={sel === p.id}
                        onClick={() => setSel(p.id)}
                        data-implant-chip={whereText(arch, p.pos)}
                        className={`inline-flex h-10 items-center gap-1.5 rounded-ctl border px-2.5 text-[0.8125rem] font-semibold tnum transition-colors duration-140 ${
                          sel === p.id ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                        }`}
                      >
                        <span className={sel === p.id ? "text-white/70" : "text-ink-400"}>{i + 1}</span>
                        {whereText(arch, p.pos)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={add}
                      disabled={items.length >= MAX_IMPLANTS || !nextPlace(items)}
                      data-implant-add
                      className="inline-flex h-10 items-center gap-1.5 rounded-ctl border border-dashed border-line-strong px-2.5 text-[0.8125rem] font-semibold text-ink-700 hover:bg-sunken disabled:opacity-45"
                    >
                      <Plus className="h-4 w-4" />
                      {F.add}
                    </button>
                  </div>

                  {selected ? (
                    <div className="grid gap-1 rounded-card border border-line p-3" data-implant-controls={whereText(arch, selected.pos)}>
                      <StepRow
                        label={F.position}
                        value={(() => {
                          const at = teethAt(arch, selected.pos);
                          return at.length === 1 ? F.at.replace("{n}", at[0]) : F.between.replace("{a}", at[0]).replace("{b}", at[1]);
                        })()}
                        hook="pos"
                        less={{ icon: <ArrowLeft className="h-5 w-5" />, label: F.toRight, on: () => change(selected.id, { pos: selected.pos - 0.05 }) }}
                        more={{ icon: <ArrowRight className="h-5 w-5" />, label: F.toLeft, on: () => change(selected.id, { pos: selected.pos + 0.05 }) }}
                      />
                      <StepRow
                        label={F.tilt}
                        value={(() => {
                          const lean = leanOf(selected.pos, selected.tilt);
                          return lean === "straight" ? F.straight : (lean === "midline" ? F.toMidline : F.toBack).replace("{n}", String(Math.abs(selected.tilt)));
                        })()}
                        hook="tilt"
                        less={{ icon: arch === "upper" ? <RotateCcw className="h-5 w-5" /> : <RotateCw className="h-5 w-5" />, label: F.turnRight, on: () => change(selected.id, { tilt: selected.tilt - 1 }) }}
                        more={{ icon: arch === "upper" ? <RotateCw className="h-5 w-5" /> : <RotateCcw className="h-5 w-5" />, label: F.turnLeft, on: () => change(selected.id, { tilt: selected.tilt + 1 }) }}
                      />
                      <StepRow
                        label={F.depth}
                        value={selected.depth === 0 ? F.level : (selected.depth > 0 ? F.deep : F.high).replace("{n}", String(Math.abs(selected.depth)))}
                        hook="depth"
                        less={{ icon: arch === "upper" ? <ArrowDown className="h-5 w-5" /> : <ArrowUp className="h-5 w-5" />, label: F.shallower, on: () => change(selected.id, { depth: selected.depth - 0.5 }) }}
                        more={{ icon: arch === "upper" ? <ArrowUp className="h-5 w-5" /> : <ArrowDown className="h-5 w-5" />, label: F.deeper, on: () => change(selected.id, { depth: selected.depth + 0.5 }) }}
                      />
                      <StepRow
                        label={F.length}
                        value={`${selected.len} mm`}
                        hook="len"
                        less={{ icon: <Minus className="h-5 w-5" />, label: F.shorter, on: () => change(selected.id, { len: stepIn(LENGTHS, selected.len, -1) }) }}
                        more={{ icon: <Plus className="h-5 w-5" />, label: F.longer, on: () => change(selected.id, { len: stepIn(LENGTHS, selected.len, 1) }) }}
                      />
                      <StepRow
                        label={F.diameter}
                        value={`Ø ${selected.dia} mm`}
                        hook="dia"
                        less={{ icon: <Minus className="h-5 w-5" />, label: F.narrower, on: () => change(selected.id, { dia: stepIn(DIAMETERS, selected.dia, -1) }) }}
                        more={{ icon: <Plus className="h-5 w-5" />, label: F.wider, on: () => change(selected.id, { dia: stepIn(DIAMETERS, selected.dia, 1) }) }}
                      />
                      {items.length > 1 && (
                        <button type="button" onClick={() => remove(selected.id)} className="mt-1 inline-flex h-10 items-center gap-1.5 justify-self-start rounded-ctl px-2 text-[0.8125rem] font-semibold text-danger hover:bg-danger-soft" data-implant-remove>
                          <Trash2 className="h-4 w-4" />
                          {F.remove}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="rounded-card border border-dashed border-line-strong px-3 py-4 text-center text-[0.8125rem] text-ink-500">{F.pick}</p>
                  )}
                </section>
              )}

              <section className="grid content-start gap-4">
                {implanted && (
                  <>
                    <div>
                      <div className="mb-1.5 text-[0.75rem] font-semibold text-ink-500">{F.on}</div>
                      <div className="inline-flex rounded-ctl bg-sunken p-0.5" role="radiogroup">
                        {(["fixed", "removable"] as const).map((k) => (
                          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} data-arch-kind={k} className={seg(kind === k)}>
                            {F[k]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1.5 text-[0.75rem] font-semibold text-ink-500">{F.material}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {materials.map((o) => (
                          <button
                            key={o.key}
                            type="button"
                            aria-pressed={material === o.key}
                            onClick={() => setMaterial(o.key)}
                            data-arch-material={o.key}
                            className={`h-10 rounded-full border px-3 text-[0.8125rem] font-semibold transition-colors duration-140 ${
                              material === o.key ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                            }`}
                          >
                            {o.en}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1.5 text-[0.75rem] font-semibold text-ink-500">{F.last}</div>
                      <div className="inline-flex rounded-ctl bg-sunken p-0.5" role="radiogroup">
                        {LAST_TEETH.map((n) => (
                          <button key={n} type="button" role="radio" aria-checked={reach === n} onClick={() => setLast(n)} data-arch-last={n} className={seg(reach === n)}>
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <div className="grid gap-1 rounded-ctl bg-canvas px-3 py-2 text-[0.8125rem] text-ink-700" data-bridge-teeth={teeth.join(",")} data-bridge-pieces={live.length + 1}>
                  <span>{(implanted && kind === "fixed" ? F.bridgeTeeth : F.dentureTeeth).replace("{from}", teeth[0] ?? "").replace("{to}", teeth[teeth.length - 1] ?? "")}</span>
                  {implanted && kind === "fixed" && (
                    <span className="text-[0.78125rem] text-ink-500">
                      <span className="font-semibold text-ink-700">{live.length ? F.pieces.replace("{n}", String(live.length + 1)) : F.onePiece}</span> · {F.split}
                    </span>
                  )}
                </div>
                {!editing && planned && standing.length > 0 && (
                  <label className="flex items-start gap-3 rounded-ctl border border-line px-3 py-2.5">
                    <input type="checkbox" checked={extract} onChange={(e) => setExtract(e.target.checked)} className="mt-0.5 h-5 w-5 accent-brand-600" data-extract-standing />
                    <span className="text-[0.8125rem] text-ink-900">
                      {F.extract.replace("{n}", String(standing.length))}
                      <span className="mt-0.5 block text-[0.75rem] text-ink-500 tnum" dir="ltr">
                        {standing.join(" · ")}
                      </span>
                    </span>
                  </label>
                )}
              </section>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5">
        {editing ? (
          <span className="text-[0.8125rem] text-ink-500 tnum" dir="ltr">
            {arch ? ordered.map((p) => whereText(arch, p.pos)).join(" · ") : ""}
          </span>
        ) : (
          <div className="inline-flex shrink-0 rounded-ctl bg-sunken p-0.5" role="radiogroup">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={status === s}
                title={T.statusHint[s]}
                onClick={() => onStatus(s)}
                className="inline-flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[0.8125rem] font-semibold"
                style={status === s ? { background: SOFT[s], color: TEXT[s], boxShadow: "var(--shadow-card)" } : { color: "var(--color-ink-500)" }}
              >
                <PaintSwatch paint={s} size={14} />
                {T.status[s]}
              </button>
            ))}
          </div>
        )}
        <div className="flex w-full gap-2 sm:w-auto">
          <Button variant="outline" onClick={onCancel} className="max-sm:flex-1">
            {T.cancel}
          </Button>
          <Button disabled={!ready} onClick={save} className="max-sm:flex-1" data-record-full-arch>
            {editing ? F.save : F.record}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The next size up or down a list of sizes, from any size. */
function stepIn(list: readonly number[], v: number, by: 1 | -1): number {
  const i = list.findIndex((x) => x >= v - 1e-6);
  const at = i < 0 ? list.length - 1 : i;
  const exact = Math.abs(list[at] - v) < 1e-6;
  const next = by > 0 ? (exact ? at + 1 : at) : at - 1;
  return list[Math.min(list.length - 1, Math.max(0, next))];
}

/* ── A row of buttons: less, what it is now, more ────────────────────────── */

type Press = { icon: React.ReactNode; label: string; on: () => void };

function StepRow({ label, value, hook, less, more }: { label: string; value: string; hook: string; less: Press; more: Press }) {
  return (
    <div className="flex items-center gap-2" data-step-row={hook}>
      <span className="w-16 shrink-0 text-[0.75rem] font-semibold text-ink-500">{label}</span>
      <Hold press={less} hook={`${hook}-less`} />
      <span className="min-w-0 flex-1 text-center text-[0.8125rem] font-semibold text-ink-900 tnum" data-step-value={hook}>
        {value}
      </span>
      <Hold press={more} hook={`${hook}-more`} />
    </div>
  );
}

/** A button that keeps going while it is held, the way a doctor eases an implant along. */
function Hold({ press, hook }: { press: Press; hook: string }) {
  const latest = useRef(press.on);
  latest.current = press.on;
  const timers = useRef<{ wait?: ReturnType<typeof setTimeout>; run?: ReturnType<typeof setInterval> }>({});
  const held = useRef(false);
  const stop = useCallback(() => {
    clearTimeout(timers.current.wait);
    clearInterval(timers.current.run);
    timers.current = {};
  }, []);
  useEffect(() => stop, [stop]);
  return (
    <button
      type="button"
      aria-label={press.label}
      title={press.label}
      data-hold={hook}
      onPointerDown={() => {
        held.current = false;
        stop();
        timers.current.wait = setTimeout(() => {
          held.current = true;
          timers.current.run = setInterval(() => latest.current(), 70);
        }, 350);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        // A hold has already moved it; a tap, and a key press, move it once.
        if (!held.current) latest.current();
        held.current = false;
      }}
      className="grid h-11 w-11 shrink-0 touch-manipulation select-none place-items-center rounded-ctl border border-line bg-surface text-ink-700 hover:bg-sunken active:bg-sunken"
    >
      {press.icon}
    </button>
  );
}

/* ── The jaw ─────────────────────────────────────────────────────────────── */

type Drag =
  | { kind: "move"; id: string; startX: number; startY: number; pos: number; depth: number; axis: "x" | "y" | null }
  | { kind: "turn"; id: string }
  | { kind: "pan"; startX: number; view: number };

function Jaw({
  arch,
  row,
  states,
  own,
  faded,
  items,
  teeth,
  cuts,
  abutment,
  material,
  splittable,
  sel,
  onSelect,
  onChange,
  onCut,
}: {
  arch: Arch;
  row: string[];
  states: Map<string, ToothState>;
  /** The group being adjusted: what the chart already draws of it is left out. */
  own: string | null;
  /** Teeth about to come out, drawn faint. */
  faded: string[];
  items: Item[];
  teeth: string[];
  cuts: Set<number>;
  abutment: ImplantTop;
  material: string | null;
  splittable: boolean;
  sel: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Place>) => void;
  onCut: (col: number) => void;
}) {
  const { t } = useI18n();
  const F = t.dental.fullArch;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A phone shows about half the jaw, and follows the implant in hand.
  const narrow = width > 0 && width < 640;
  const viewW = narrow ? NARROW_COLS * CW : FULL_W + 12;
  const bound = useCallback((x: number) => Math.min(FULL_W + 6 - viewW, Math.max(-6, x)), [viewW]);
  const [viewX, setViewX] = useState<number | null>(null);
  const x0 = narrow ? (viewX ?? bound((FULL_W - viewW) / 2)) : -6;
  const drag = useRef<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = items.find((i) => i.id === sel) ?? null;
  const selX = selected ? selected.pos * CW + CW / 2 : null;

  // Glide to the implant chosen, or to where it was let go.
  const at = useRef(x0);
  at.current = x0;
  useEffect(() => {
    if (!narrow || selX === null || busy) return;
    const to = bound(selX - viewW / 2);
    const from = at.current;
    if (Math.abs(to - from) < 1) return;
    let frame = 0;
    const t0 = performance.now();
    const go = (now: number) => {
      const k = Math.min(1, (now - t0) / 180);
      setViewX(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) frame = requestAnimationFrame(go);
    };
    frame = requestAnimationFrame(go);
    return () => cancelAnimationFrame(frame);
    // Moves when the choice changes or a drag ends, not while one is under way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, busy, narrow, viewW]);

  const upper = arch === "upper";
  const H = SIDE_H + NUM + PAD;
  // Drawn as an upper jaw, then turned over for a lower one.
  const sideY = upper ? PAD : NUM;
  const toLocal = (y: number) => (upper ? y - sideY : SIDE_H - (y - sideY));
  const fromLocal = (y: number) => (upper ? sideY + y : sideY + SIDE_H - y);
  const unit = width > 0 ? viewW / width : 1; // chart units in a pixel
  const platform = (p: Place) => ARCH_PLATFORM - p.depth * MM;
  const tip = (p: Place, beyond: number) => {
    const r = (p.tilt * Math.PI) / 180;
    const d = p.len * MM + beyond;
    return { x: p.pos * CW + CW / 2 + Math.sin(r) * d, y: platform(p) - Math.cos(r) * d };
  };
  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const el = svg.current!;
    const r = el.getBoundingClientRect();
    return { x: x0 + ((e.clientX - r.left) / r.width) * viewW, y: ((e.clientY - r.top) / r.height) * H };
  };

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId);
    drag.current = d;
    setBusy(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (d.kind === "pan") {
      const r = svg.current!.getBoundingClientRect();
      setViewX(bound(d.view - ((e.clientX - d.startX) / r.width) * viewW));
      return;
    }
    const item = items.find((i) => i.id === d.id);
    if (!item) return;
    if (d.kind === "turn") {
      const dx = p.x - (item.pos * CW + CW / 2);
      const dy = toLocal(p.y) - platform(item);
      const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      onChange(d.id, { tilt: snapTilt(Math.max(-MAX_TILT, Math.min(MAX_TILT, deg))) });
      return;
    }
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // Which way it is going is settled by the first few pixels: along the jaw, or into it.
    if (!d.axis) {
      if (Math.hypot(dx, dy) < 6) return;
      d.axis = Math.abs(dy) > Math.abs(dx) * 1.7 ? "y" : "x";
    }
    if (d.axis === "x") {
      onChange(d.id, { pos: d.pos + (dx * unit) / CW });
      // At the edge of a phone's window, the jaw moves on under the finger.
      if (narrow) {
        const edge = viewW * 0.12;
        if (p.x < x0 + edge) setViewX(bound(x0 - edge * 0.25));
        else if (p.x > x0 + viewW - edge) setViewX(bound(x0 + edge * 0.25));
      }
    } else {
      const into = (upper ? -dy : dy) * unit;
      onChange(d.id, { depth: Math.round(Math.max(DEPTHS.min, Math.min(DEPTHS.max, d.depth + into / MM)) * 2) / 2 });
    }
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setBusy(false);
  };

  const onKey = (e: React.KeyboardEvent, p: Item) => {
    const big = e.shiftKey ? 5 : 1;
    const into = upper ? "ArrowUp" : "ArrowDown";
    if (e.key === "ArrowLeft") onChange(p.id, { pos: p.pos - 0.05 * big });
    else if (e.key === "ArrowRight") onChange(p.id, { pos: p.pos + 0.05 * big });
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") onChange(p.id, { depth: p.depth + (e.key === into ? 0.5 : -0.5) });
    else if (e.key === "[") onChange(p.id, { tilt: p.tilt - big });
    else if (e.key === "]") onChange(p.id, { tilt: p.tilt + big });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // The chart's own teeth, without what this arch already draws on them.
  const bare = useCallback(
    (f: string): ToothState => {
      const st = stateOf(states, f);
      const layers = st.layers.filter((l) => l.groupId !== own && l.look !== "extraction" && l.look !== "perio");
      // Under the new bridge: covered, so a missing tooth's outline is not drawn through it.
      if (teeth.includes(f)) layers.push({ markId: COVER, look: "denture", paint: "existing", surfaces: [], detail: {} });
      return { ...st, badges: [], layers };
    },
    [states, own, teeth]
  );
  const gone = (n: number) => (row[n] ? stateOf(states, row[n]).gone : true);
  const pieces = useMemo(() => {
    const sorted = teeth.map((f) => ({ t: tooth(f), col: colOf(f) })).sort((a, b) => a.col - b.col);
    const out: { t: ReturnType<typeof tooth>; x: number; col: number }[][] = [];
    for (const u of sorted) {
      const prev = out[out.length - 1];
      const lastU = prev?.[prev.length - 1];
      if (lastU && u.col === lastU.col + 1 && !cuts.has(lastU.col)) prev.push({ ...u, x: u.col * CW });
      else out.push([{ ...u, x: u.col * CW }]);
    }
    return out;
  }, [teeth, cuts]);
  const flip = upper ? undefined : `matrix(1 0 0 -1 0 ${SIDE_H})`;
  const handleR = Math.max(6.5, 11 * unit);
  const hitR = Math.max(10, 23 * unit);
  const numY = upper ? PAD + SIDE_H + NUM / 2 + 4 : NUM / 2 + 4;
  const firstCol = teeth.length ? Math.min(...teeth.map(colOf)) : 0;
  const lastCol = teeth.length ? Math.max(...teeth.map(colOf)) : 0;

  return (
    <div ref={wrap} className="w-full" dir="ltr">
      <svg
        ref={svg}
        viewBox={`${x0} 0 ${viewW} ${H}`}
        className="block h-auto w-full select-none"
        style={{ touchAction: "pan-y", aspectRatio: `${viewW} / ${H}` }}
        role="group"
        aria-label={t.dental.sites[arch]}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerDown={(e) => {
          if (narrow) begin(e, { kind: "pan", startX: e.clientX, view: x0 });
        }}
        data-jaw={arch}
      >
        {row.map((f, c) => {
          const st = bare(f);
          return (
            <g key={f} transform={`translate(${c * CW} ${sideY})`}>
              {faded.includes(f) ? (
                // About to come out: the healed jaw it will leave, and the tooth as a shadow on it.
                <>
                  <ToothSide t={tooth(f)} st={{ ...st, gone: true }} uid={`${uid}-g`} drawn={COVERED} gone={{ left: gone(c - 1) || faded.includes(row[c - 1]), right: gone(c + 1) || faded.includes(row[c + 1]) }} />
                  <g opacity={0.26}>
                    <ToothSide t={tooth(f)} st={st} uid={`${uid}-j`} drawn={COVERED} bare />
                  </g>
                </>
              ) : (
                <ToothSide t={tooth(f)} st={st} uid={`${uid}-j`} drawn={COVERED} gone={st.gone ? { left: gone(c - 1), right: gone(c + 1) } : undefined} />
              )}
            </g>
          );
        })}
        <line x1={FULL_W / 2} y1={0} x2={FULL_W / 2} y2={H} style={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }} strokeDasharray="3 4" />

        <g transform={`translate(0 ${sideY})`} pointerEvents="none">
          <g transform={flip}>
            {items.map((p) => (
              <ImplantArt key={p.id} arch solid x={p.pos * CW + CW / 2} place={p} paint={p.id === sel ? "done" : "existing"} top={abutment} />
            ))}
            {/* Seen through, so what is under it can be placed. */}
            <g opacity={items.length ? 0.6 : 1}>
              {pieces.map((units, i) => (
                <PieceSide key={units[0].col} units={units} arch={arch} base material={material} paint="existing" seams={{ left: i > 0, right: i < pieces.length - 1 }} uid={`${uid}-s${i}`} still />
              ))}
            </g>
          </g>
        </g>

        {/* The numbers, and the joints between them. */}
        {row.map((f, c) => {
          const inBridge = teeth.includes(f);
          return (
            <text key={`n${f}`} x={c * CW + CW / 2} y={numY} textAnchor="middle" fontSize={11} fontWeight={600} className={`tnum ${inBridge ? "fill-ink-700" : "fill-ink-400"}`} style={{ fontFamily: "var(--font-sans)" }} pointerEvents="none">
              {f}
            </text>
          );
        })}
        {splittable &&
          row.slice(0, -1).map((f, c) => {
            if (c < firstCol || c >= lastCol) return null;
            const on = cuts.has(c);
            return (
              <g
                key={`c${c}`}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={F.joint.replace("{a}", f).replace("{b}", row[c + 1])}
                data-joint={`${f}-${row[c + 1]}`}
                className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-brand-600"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onCut(c);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onCut(c);
                  }
                }}
              >
                <rect x={(c + 1) * CW - 14} y={numY - 15} width={28} height={22} fill="transparent" />
                <circle cx={(c + 1) * CW} cy={numY - 4} r={on ? 7 : 4.5} style={{ fill: on ? "var(--color-brand-600)" : "var(--color-surface)", stroke: on ? "var(--color-brand-600)" : "var(--color-line-strong)", strokeWidth: 1.1 }} />
                {on && <Scissors x={(c + 1) * CW - 4} y={numY - 8} width={8} height={8} color="var(--color-on-brand, white)" strokeWidth={2.6} />}
              </g>
            );
          })}

        {/* What is held: each implant's body, and the chosen one's tip. */}
        {items.map((p, i) => {
          const x = p.pos * CW + CW / 2;
          const label = `${F.implantN.replace("{n}", String(i + 1))}: ${teethAt(arch, p.pos).join("–")}`;
          return (
            <g
              key={`h${p.id}`}
              role="button"
              tabIndex={0}
              aria-pressed={p.id === sel}
              aria-label={label}
              data-implant={whereText(arch, p.pos)}
              data-implant-id={p.id}
              data-implant-tilt={p.tilt}
              className="cursor-grab outline-none active:cursor-grabbing [&:focus-visible>path]:stroke-brand-400"
              style={{ touchAction: "none" }}
              onFocus={() => onSelect(p.id)}
              onKeyDown={(e) => onKey(e, p)}
              onPointerDown={(e) => {
                onSelect(p.id);
                begin(e, { kind: "move", id: p.id, startX: e.clientX, startY: e.clientY, pos: p.pos, depth: p.depth, axis: null });
              }}
            >
              <g transform={`translate(0 ${sideY})`}>
                <g transform={flip}>
                  <g transform={`translate(${x} ${platform(p)}) rotate(${p.tilt})`}>
                    <path d={implantOutline(p.len, p.dia)} style={{ fill: "transparent", stroke: "transparent", strokeWidth: Math.max(8, 20 * unit) }} />
                    {p.id === sel && <path d={implantOutline(p.len, p.dia)} style={{ fill: "none", stroke: "var(--color-brand-400)", strokeWidth: 1.6 }} pointerEvents="none" />}
                  </g>
                </g>
              </g>
            </g>
          );
        })}
        {selected &&
          (() => {
            const h = tip(selected, 11);
            const a = tip(selected, 1);
            const hy = fromLocal(h.y);
            const ay = fromLocal(a.y);
            // Kept inside the picture when a long implant reaches past it.
            const y = Math.min(H - handleR - 1, Math.max(handleR + 1, hy));
            return (
              <g data-turn-handle={selected.id} style={{ touchAction: "none" }} className="cursor-grab active:cursor-grabbing" onPointerDown={(e) => begin(e, { kind: "turn", id: selected.id })}>
                <line x1={a.x} y1={ay} x2={h.x} y2={y} style={{ stroke: "var(--color-brand-600)", strokeWidth: 1.2 }} strokeDasharray="2 2" />
                <circle cx={h.x} cy={y} r={hitR} fill="transparent" />
                <circle cx={h.x} cy={y} r={handleR} style={{ fill: "var(--color-surface)", stroke: "var(--color-brand-600)", strokeWidth: 1.5 }} />
                <RotateCw x={h.x - handleR * 0.58} y={y - handleR * 0.58} width={handleR * 1.16} height={handleR * 1.16} color="var(--color-brand-600)" strokeWidth={2.4} />
              </g>
            );
          })()}
      </svg>
    </div>
  );
}
