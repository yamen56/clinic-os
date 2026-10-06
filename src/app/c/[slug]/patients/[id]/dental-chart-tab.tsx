"use client";

/*
  The dental chart tab — PREVIEW.

  Everything here lives in this component's state and nothing is written
  anywhere: it is shown to the Clinicti team only, on real patient files, so
  the drawing and the way it feels at the chair can be judged in place before a
  single table exists. Leaving the tab or reloading starts again from the
  sample mouth. The shapes of `Mark` and `MarkEvent` are the shapes the tables
  will have, so what is learned here carries straight over.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, MousePointer2, Paintbrush, Plus, History as HistoryIcon, Undo2, ChevronDown } from "lucide-react";
import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { fmtDateOnly } from "@/lib/dates";
import { BORROWABLE_LOOKS, BUILT_IN, PROCEDURE_CATEGORIES, findTreatment, type Category, type Look, type Scope, type Treatment } from "@/lib/charts/dental/catalog";
import { PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, dentitionForAge, tooth as toothOf, type Dentition, type Surface } from "@/lib/charts/dental/teeth";
import { endOfDay, eventDays, isToothSite, paintAt, toothStates, type Mark, type MarkEvent, type Paint, type Person, type Status } from "@/lib/charts/dental/state";
import { DentalDefs, INK, PaintSwatch, SOFT } from "@/components/charts/dental/tooth-art";
import { Odontogram, neighbour } from "@/components/charts/dental/odontogram";
import { MouthGlyph, type MouthRegion } from "@/components/charts/dental/mouth-art";
import { DockSheet, SHEET_SHARE } from "@/components/charts/dental/dock-sheet";
import { iconFor } from "@/components/charts/dental/icons";
import { ToothPanel, type PanelActions } from "@/components/charts/dental/tooth-panel";
import { TreatmentGlyph, TreatmentPicker, type Favorite } from "@/components/charts/dental/treatment-picker";
import { EntryRow, EventList } from "@/components/charts/dental/history";
import { siteLabel } from "@/components/charts/dental/labels";
import { sampleMouth, samplePeople } from "@/components/charts/dental/sample";

const ORDER = [...PERMANENT_UPPER, ...PRIMARY_UPPER, ...PRIMARY_LOWER, ...PERMANENT_LOWER];
const siteOrder = (s: string) => {
  const i = ORDER.indexOf(s);
  return i === -1 ? -1 : i;
};
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const PAINTS: Paint[] = ["planned", "done", "existing", "finding"];
const STATUSES: Status[] = ["planned", "done", "existing"];

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { key: T; label: React.ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="inline-flex shrink-0 rounded-ctl bg-sunken p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          onClick={() => onChange(o.key)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-semibold transition-colors duration-140 ${
            value === o.key ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusPicker({ value, onChange }: { value: Status; onChange: (s: Status) => void }) {
  const { t } = useI18n();
  return (
    <div className="inline-flex shrink-0 rounded-ctl bg-sunken p-0.5" role="radiogroup">
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          title={t.dental.statusHint[s]}
          onClick={() => onChange(s)}
          className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-semibold transition-colors duration-140"
          style={value === s ? { background: SOFT[s], color: INK[s], boxShadow: "var(--shadow-card)" } : { color: "var(--color-ink-500)" }}
        >
          <PaintSwatch paint={s} size={14} />
          {t.dental.status[s]}
        </button>
      ))}
    </div>
  );
}

function CustomTreatmentModal({ open, onClose, onSave, me }: { open: boolean; onClose: () => void; onSave: (tr: Treatment) => void; me: Person }) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const C = T.custom;
  const [en, setEn] = useState("");
  const [abbr, setAbbr] = useState("");
  const [category, setCategory] = useState<Category>("restorative");
  const [scope, setScope] = useState<Scope>("tooth");
  const [look, setLook] = useState<Look>("dot");
  useEffect(() => {
    if (open) {
      setEn("");
      setAbbr("");
    }
  }, [open]);
  const field = "h-10 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm focus:border-brand-600 focus:outline-none";
  // Named in English like the rest of the chart. The record keeps an `ar`
  // field for the day a patient-facing paper wants one; until then it is the
  // English name, never a blank.
  const save = () => {
    if (!en.trim()) return;
    onSave({
      key: `custom:${newId()}`,
      kind: category === "findings" ? "finding" : "procedure",
      category,
      ar: en.trim(),
      en: en.trim(),
      abbr: abbr.trim() || undefined,
      scope,
      needsSurfaces: scope === "surface",
      look: scope === "surface" && look === "dot" ? "filling" : look,
      custom: { addedBy: me.name, addedAt: new Date().toISOString() },
    });
  };
  const sample = toothOf("16");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={C.title}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {T.cancel}
          </Button>
          <Button onClick={save} disabled={!en.trim()}>
            {C.save}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-[13px] text-ink-500">{C.hint}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[13px] font-semibold">{C.name}</span>
            <input autoFocus value={en} onChange={(e) => setEn(e.target.value)} placeholder={C.namePlaceholder} className={field} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-semibold">{C.abbr}</span>
            <input dir="ltr" value={abbr} onChange={(e) => setAbbr(e.target.value)} className={field} maxLength={8} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-semibold">{C.category}</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className={`${field} select-chevron appearance-none pe-8`}>
              {(["findings", ...PROCEDURE_CATEGORIES] as Category[]).map((c) => (
                <option key={c} value={c}>
                  {T.categories[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[13px] font-semibold">{C.scope}</span>
            <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className={`${field} select-chevron appearance-none pe-8`}>
              {(["surface", "tooth", "quadrant", "arch", "mouth"] as Scope[]).map((s) => (
                <option key={s} value={s}>
                  {T.scopes[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <span className="mb-1.5 block text-[13px] font-semibold">{C.look}</span>
          <div className="flex flex-wrap gap-2">
            {BORROWABLE_LOOKS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLook(l)}
                aria-pressed={look === l}
                className={`grid h-16 w-12 place-items-center rounded-ctl border transition-colors ${look === l ? "border-brand-600 bg-brand-50" : "border-line hover:bg-sunken"}`}
              >
                <TreatmentGlyph tr={{ key: `look-${l}`, kind: "procedure", category: "restorative", en: l, ar: l, scope: "tooth", look: l }} paint="done" context={sample} size={40} />
              </button>
            ))}
          </div>
        </div>
        <p className="text-[12px] text-ink-500">{C.byline.replace("{name}", me.name)} · {fmtDateOnly(new Date(), locale)}</p>
      </div>
    </Modal>
  );
}

type TabProps = { tz: string; birthDate: string | null; me: Person; doctors: Person[] };

/*
  English inside, whatever the workspace speaks.

  Dentists here trained in English and chart in it — "MO composite", "RCT on
  36" — and the Arabic terms read as a translation nobody at the chair uses.
  So the chart runs under its own provider: English for the catalog, the tooth
  names, the surfaces and the dates, and left to right, while the file around
  it stays in the clinic's language. Both dictionaries already carry the same
  English `dental` block, so this only switches the locale; no second
  dictionary is shipped to the browser.
*/
export function DentalChartTab(props: TabProps) {
  const { t } = useI18n();
  return (
    <I18nProvider dict={t} locale="en">
      <div dir="ltr" lang="en" className="font-sans" data-latin-island>
        <DentalChart {...props} />
      </div>
    </I18nProvider>
  );
}

function DentalChart({ tz, birthDate, me, doctors }: TabProps) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const { toast } = useToast();

  const people = useMemo(() => samplePeople(locale), [locale]);
  const roster = useMemo(() => {
    const list = [...doctors, people.sara, people.omar];
    return list.filter((p, i) => list.findIndex((x) => x.id === p.id) === i);
  }, [doctors, people]);

  const [marks, setMarks] = useState<Mark[]>([]);
  const [events, setEvents] = useState<MarkEvent[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [custom, setCustom] = useState<Treatment[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const loadSample = useCallback(() => {
    const s = sampleMouth(locale);
    setMarks(s.marks);
    setEvents(s.events);
    setFavorites(s.favorites);
  }, [locale]);
  useEffect(() => loadSample(), [loadSample]);

  const [selected, setSelected] = useState<string[]>([]);
  const [picked, setPicked] = useState<Surface[]>([]);
  const [flash, setFlash] = useState(false);
  const [mode, setMode] = useState<"tooth" | "brush">("tooth");
  const [brush, setBrush] = useState<Treatment | null>(null);
  const [brushPicker, setBrushPicker] = useState(false);
  const [status, setStatus] = useState<Status>("done");
  const [performer, setPerformer] = useState(roster[0]?.id ?? "");
  const [dentition, setDentition] = useState<Dentition>(() => dentitionForAge(birthDate));
  const [half, setHalf] = useState<"right" | "left">("right");
  const [show, setShow] = useState<Record<Paint, boolean>>({ planned: true, done: true, existing: true, finding: true });
  const [dayIdx, setDayIdx] = useState<number | null>(null);
  const [span, setSpan] = useState<Treatment | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(false);
  const [scoped, setScoped] = useState<Treatment | null>(null);
  const [voiding, setVoiding] = useState<Mark | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [lastAdded, setLastAdded] = useState<{ ids: string[]; text: string; key: number } | null>(null);
  const [historyDoctor, setHistoryDoctor] = useState("");
  /** A whole-mouth card being pointed at, and the one opened. */
  const [mouthHover, setMouthHover] = useState<MouthRegion | null>(null);
  const [mouthEntry, setMouthEntry] = useState<string | null>(null);

  /*
    Wide enough for the panel beside the chart, or narrow enough for half a
    mouth. The panel needs a laptop's width: on an iPad in landscape it left
    the chart a third of the screen and every tooth the size of a fingertip's
    edge, so there it opens as a sheet over the chart instead.
  */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 1040));
    ro.observe(el);
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", on);
    };
  }, []);

  useEffect(() => {
    if (!lastAdded) return;
    const id = setTimeout(() => setLastAdded(null), 6000);
    return () => clearTimeout(id);
  }, [lastAdded]);

  /*
    At a desk: the arrow keys walk from tooth to tooth — along the arch, and up
    or down to the other jaw — and Escape puts the tooth down. Never while
    typing, and never under a dialog that has its own Escape.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "Escape" && selected.length) {
        setSelected([]);
        setPicked([]);
        setSpan(null);
        return;
      }
      if (mode !== "tooth" || selected.length !== 1) return;
      const next = neighbour(selected[0], e.key, dentition);
      if (!next) return;
      e.preventDefault();
      setSelected([next]);
      setPicked([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, mode, dentition]);

  /*
    With the panel docked at the bottom, the tooth being worked on has to stay
    in the open part of the screen above it — otherwise the doctor taps a
    treatment and the tooth that changes is hidden behind the panel. Scrolled
    only when it is actually out of view, so moving along the arch does not
    make the page swim.
  */
  const sheetOpen = !wide && selected.length > 0 && mode === "tooth";
  useEffect(() => {
    if (!sheetOpen) return;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-dental-chart] svg [data-tooth="${selected[selected.length - 1]}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const top = 72; // under the phone's top bar
      const open = window.innerHeight * (1 - SHEET_SHARE);
      if (r.top >= top && r.bottom <= open - 8) return;
      window.scrollBy({ top: r.top - Math.max(top, (open - r.height) / 2), behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [sheetOpen, selected]);

  // A phone shows half the mouth; a sideways swipe across it shows the other.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0];
    swipe.current = { x: p.clientX, y: p.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || !phone) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - s.x;
    if (Math.abs(dx) > 56 && Math.abs(p.clientY - s.y) < 40) setHalf(dx < 0 ? "left" : "right");
  };

  const days = useMemo(() => eventDays(marks, tz), [marks, tz]);
  const at = dayIdx === null || dayIdx >= days.length ? null : endOfDay(days[dayIdx], tz);
  const past = at !== null;
  const states = useMemo(() => toothStates(marks, at), [marks, at]);
  const visible = useCallback((p: Paint) => show[p], [show]);
  const catalog = useMemo(() => [...BUILT_IN, ...custom], [custom]);
  const categoryOf = useCallback((key: string) => findTreatment(key, custom)?.category, [custom]);
  const performerPerson = roster.find((d) => d.id === performer) ?? null;

  /* ── Recording ───────────────────────────────────────────────────────── */

  const defaultsFor = (tr: Treatment, site: string): Record<string, string> => {
    const d: Record<string, string> = {};
    for (const f of tr.details ?? []) {
      d[f.key] = f.key === "canals" && isToothSite(site) ? String(toothOf(site).roots) : f.options[0].key;
    }
    return d;
  };

  const record = (tr: Treatment, sites: { site: string; surfaces: Surface[]; role?: Mark["role"] }[], groupId?: string) => {
    const now = new Date().toISOString();
    const st: Status = tr.kind === "finding" ? "existing" : status;
    const fresh: Mark[] = sites.map((s) => ({
      id: newId(),
      site: s.site,
      surfaces: s.surfaces,
      treatmentKey: tr.key,
      label: tr.en,
      labelAr: tr.ar,
      abbr: tr.abbr,
      look: tr.look,
      kind: tr.kind,
      detail: defaultsFor(tr, s.site),
      status: st,
      groupId,
      role: s.role,
      performedBy: performerPerson,
      recordedBy: me,
      createdAt: now,
      doneAt: st === "done" ? now : null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      note: "",
    }));
    setMarks((prev) => [...prev, ...fresh]);
    setEvents((prev) => [...prev, ...fresh.map((m) => ({ id: newId(), markId: m.id, action: "created" as const, at: now, by: me }))]);
    setRecent((prev) => [tr.key, ...prev.filter((k) => k !== tr.key)].slice(0, 8));
    const where = sites.map((s) => (isToothSite(s.site) ? s.site : siteLabel(s.site, T))).join(" · ");
    setLastAdded({ ids: fresh.map((m) => m.id), text: T.added.replace("{name}", locale === "ar" ? tr.ar : tr.en).replace("{site}", where), key: Date.now() });
  };

  const removeMarks = (ids: Set<string>) => {
    setMarks((prev) => prev.filter((m) => !ids.has(m.id)));
    setEvents((prev) => prev.filter((e) => !ids.has(e.markId)));
  };
  const undo = () => {
    if (!lastAdded) return;
    removeMarks(new Set(lastAdded.ids));
    setLastAdded(null);
  };

  const sitesFor = (tr: Treatment, teeth: string[]) => {
    if (tr.scope === "mouth") return [{ site: "mouth", surfaces: [] as Surface[] }];
    if (tr.scope === "arch") return uniq(teeth.map((f) => toothOf(f).arch)).map((a) => ({ site: a, surfaces: [] as Surface[] }));
    if (tr.scope === "quadrant") return uniq(teeth.map((f) => `Q${((toothOf(f).quadrant - 1) % 4) + 1}`)).map((q) => ({ site: q, surfaces: [] as Surface[] }));
    return teeth.map((f) => ({ site: f, surfaces: tr.needsSurfaces ? picked : [] }));
  };

  /** A bridge: the teeth already gone are the ones it replaces, the rest hold it. */
  const recordSpan = (tr: Treatment, teeth: string[]) => {
    const ordered = [...teeth].sort((a, b) => siteOrder(a) - siteOrder(b));
    const bridge = tr.look === "crown";
    record(
      tr,
      ordered.map((f) => ({ site: f, surfaces: [], role: bridge ? (states.get(f)?.gone ? ("pontic" as const) : ("abutment" as const)) : undefined })),
      newId()
    );
    setSpan(null);
  };

  const pick = (tr: Treatment) => {
    if (past || selected.length === 0) return;
    if (tr.needsSurfaces && picked.length === 0) {
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
      toast(T.needSurfaces, "error");
      return;
    }
    if (tr.scope === "span") {
      if (selected.length >= 2) recordSpan(tr, selected);
      else setSpan(tr);
      return;
    }
    record(tr, sitesFor(tr, selected));
    setPicked([]);
  };

  /*
    Brush: the treatment is chosen once and painted on with taps. Painting the
    next surface of a filling just made extends it — O, then M, is one MO
    filling — and tapping what was just painted takes it off again. Both only
    within a minute of the first dab and only for the person painting: after
    that it is a record like any other, and leaves the chart by being voided.
  */
  const paint = (fdi: string, s: Surface | null) => {
    if (!brush) return;
    const tr = brush;
    const prior = [...marks].reverse().find((m) => !m.voidedAt && m.site === fdi && m.treatmentKey === tr.key && m.recordedBy.id === me.id && Date.now() - Date.parse(m.createdAt) < 60_000);
    if (tr.needsSurfaces) {
      const sf = s ?? "O";
      if (prior) {
        const next = prior.surfaces.includes(sf) ? prior.surfaces.filter((x) => x !== sf) : [...prior.surfaces, sf];
        if (next.length === 0) removeMarks(new Set([prior.id]));
        else setMarks((prev) => prev.map((m) => (m.id === prior.id ? { ...m, surfaces: next } : m)));
        return;
      }
      record(tr, [{ site: fdi, surfaces: [sf] }]);
      return;
    }
    if (prior) {
      removeMarks(new Set([prior.id]));
      return;
    }
    record(tr, [{ site: fdi, surfaces: [] }]);
  };

  const onTooth = (fdi: string, additive: boolean) => {
    if (mode === "brush") {
      if (!brush) setBrushPicker(true);
      else if (!past) paint(fdi, null);
      return;
    }
    if (span || additive) {
      setSelected((prev) => (prev.includes(fdi) ? prev.filter((x) => x !== fdi) : [...prev, fdi]));
      return;
    }
    if (!(selected.length === 1 && selected[0] === fdi)) {
      setSelected([fdi]);
      setPicked([]);
    }
  };
  const togglePicked = (s: Surface) => setPicked((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const onSurface = (fdi: string, s: Surface, additive: boolean) => {
    if (mode === "brush") {
      if (!brush) setBrushPicker(true);
      else if (!past) paint(fdi, s);
      return;
    }
    if (span || additive) return onTooth(fdi, true);
    if (selected.length === 1 && selected[0] === fdi) togglePicked(s);
    else {
      setSelected([fdi]);
      setPicked([s]);
    }
  };
  const closePanel = () => {
    setSelected([]);
    setPicked([]);
    setSpan(null);
  };

  /* ── Changing what is recorded ───────────────────────────────────────── */

  const logEvent = (markId: string, action: MarkEvent["action"], reason?: string) =>
    setEvents((prev) => [...prev, { id: newId(), markId, action, at: new Date().toISOString(), by: me, reason }]);
  const patchMark = (id: string, fn: (m: Mark) => Mark) => setMarks((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  const actions: PanelActions = {
    onTogglePicked: togglePicked,
    onStatus: setStatus,
    onPerformer: setPerformer,
    onPick: pick,
    onToggleFavorite: (key) =>
      setFavorites((prev) => (prev.some((f) => f.key === key) ? prev.filter((f) => f.key !== key) : [...prev, { key, addedBy: me, addedAt: new Date().toISOString() }])),
    onAddCustom: () => setCustomOpen(true),
    onSpanRecord: () => span && recordSpan(span, selected),
    onSpanCancel: () => setSpan(null),
    onMarkDone: (id) => {
      patchMark(id, (m) => ({ ...m, status: "done", doneAt: new Date().toISOString(), performedBy: m.performedBy ?? performerPerson }));
      logEvent(id, "done");
    },
    onVoid: (m) => {
      setVoidReason("");
      setVoiding(m);
    },
    onNote: (id, note) => {
      patchMark(id, (m) => ({ ...m, note }));
      logEvent(id, "note");
    },
    onDetail: (id, key, value) => patchMark(id, (m) => ({ ...m, detail: { ...m.detail, [key]: value } })),
    onEntryPerformer: (id, pid) => {
      patchMark(id, (m) => ({ ...m, performedBy: roster.find((d) => d.id === pid) ?? m.performedBy }));
      logEvent(id, "performer");
    },
    onClose: closePanel,
  };

  const confirmVoid = () => {
    if (!voiding || !voidReason.trim()) return;
    const now = new Date().toISOString();
    patchMark(voiding.id, (m) => ({ ...m, voidedAt: now, voidedBy: me, voidReason: voidReason.trim() }));
    logEvent(voiding.id, "void", voidReason.trim());
    setVoiding(null);
  };

  const pickWholeMouth = (tr: Treatment, site?: string) => {
    if (tr.scope === "mouth" || site) {
      record(tr, [{ site: site ?? "mouth", surfaces: [] }]);
      setScoped(null);
      setMouthOpen(false);
      return;
    }
    setScoped(tr);
  };

  /* ── What the screen shows ───────────────────────────────────────────── */

  const live = marks.filter((m) => !m.voidedAt);
  const mouthMarks = marks.filter((m) => !isToothSite(m.site) && paintAt(m, at) && visible(paintAt(m, at)!));
  const remaining = live.filter((m) => m.status === "planned").sort((a, b) => siteOrder(a.site) - siteOrder(b.site));
  const historyEvents = historyDoctor ? events.filter((e) => marks.find((m) => m.id === e.markId)?.performedBy?.id === historyDoctor) : events;

  const panel = selected.length > 0 && mode === "tooth" && (
    <ToothPanel
      teeth={selected}
      states={states}
      marks={marks}
      events={events}
      custom={custom}
      catalog={catalog}
      favorites={favorites}
      recent={recent}
      picked={picked}
      flash={flash}
      status={status}
      performer={performer}
      doctors={roster}
      span={span}
      past={past}
      tz={tz}
      a={actions}
    />
  );

  const brushCatalog = useMemo(() => catalog.filter((tr) => tr.scope === "tooth" || tr.scope === "surface"), [catalog]);
  const brushPickerBody = (
    <div className="grid gap-3">
      <p className="text-[13px] text-ink-500">{T.brushHint}</p>
      <div className="flex flex-wrap items-end gap-3">
        <StatusPicker value={status} onChange={setStatus} />
        <label className="block min-w-40 flex-1">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{T.performedBy}</span>
          <select value={performer} onChange={(e) => setPerformer(e.target.value)} className="select-chevron h-9 w-full appearance-none rounded-ctl border border-line bg-surface ps-3 pe-8 text-base md:text-sm">
            {roster.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <TreatmentPicker
        catalog={brushCatalog}
        context={null}
        favorites={favorites}
        recent={recent}
        paint={status}
        tz={tz}
        onPick={(tr) => {
          setBrush(tr);
          setBrushPicker(false);
        }}
        onToggleFavorite={actions.onToggleFavorite}
        onAddCustom={() => setCustomOpen(true)}
      />
    </div>
  );

  const dayLabel = at === null ? T.today : fmtDateOnly(days[dayIdx!], locale);
  const sideBySide = wide && (mode === "brush" || !!panel);

  return (
    <div ref={wrapRef} className="grid gap-4" data-dental-chart>
      <DentalDefs />

      {/* Preview banner: what this is and who can see it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-brand-200 bg-brand-50 px-4 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 text-white">
          <Eye className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-[13rem] flex-1 text-[13px] leading-snug">
          <span className="font-semibold text-ink-900">{T.previewTitle} · </span>
          <span className="text-ink-700">
            {T.preview} {T.sampleNote}
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={loadSample}>
            {T.loadSample}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setMarks([]);
              setEvents([]);
              setDayIdx(null);
              closePanel();
            }}
          >
            {T.clearAll}
          </Button>
        </div>
      </div>

      {/*
        The chart has the whole width until there is something to hold beside
        it: a tooth being worked on, or the brush's treatments. An empty panel
        would only make every tooth smaller.
      */}
      <div className={sideBySide ? "grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4" : "grid gap-4"}>
        <Card className="relative p-3 sm:p-4">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={mode}
              onChange={(m) => {
                setMode(m);
                closePanel();
                if (m === "brush" && !brush && !wide) setBrushPicker(true);
              }}
              options={[
                { key: "tooth", label: (<><MousePointer2 className="h-3.5 w-3.5" />{T.modeTooth}</>) },
                { key: "brush", label: (<><Paintbrush className="h-3.5 w-3.5" />{T.modeBrush}</>) },
              ]}
            />
            {mode === "brush" && (
              <button
                type="button"
                onClick={() => setBrushPicker(true)}
                className="inline-flex h-9 max-w-full items-center gap-2 rounded-ctl border border-line bg-surface ps-1.5 pe-2.5 text-[13px] font-semibold hover:bg-sunken"
                data-brush={brush?.key ?? ""}
              >
                {brush ? <TreatmentGlyph tr={brush} paint={brush.kind === "finding" ? "finding" : status} context={null} size={26} /> : <Paintbrush className="ms-1 h-4 w-4 text-ink-400" />}
                <span className="truncate">{brush ? (locale === "ar" ? brush.ar : brush.en) : T.brushPick}</span>
                {brush && brush.kind !== "finding" && (
                  <span className="rounded-full px-1.5 py-0.5 text-[11px]" style={{ background: SOFT[status], color: INK[status] }}>
                    {T.status[status]}
                  </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
              </button>
            )}
            <div className="ms-auto">
              <Segmented
                value={dentition}
                onChange={setDentition}
                options={(["permanent", "mixed", "primary"] as Dentition[]).map((d) => ({ key: d, label: T.dentition[d] }))}
              />
            </div>
          </div>

          {/* Legend: each ink can be hidden, to read one layer of the mouth at a time. */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {PAINTS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={show[p]}
                onClick={() => setShow((s) => ({ ...s, [p]: !s[p] }))}
                title={T.statusHint[p]}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border ps-1.5 pe-2.5 text-[12px] font-semibold transition-opacity duration-140 ${show[p] ? "" : "opacity-40"}`}
                style={{ borderColor: SOFT[p], background: show[p] ? SOFT[p] : "transparent", color: INK[p] }}
              >
                <PaintSwatch paint={p} size={18} />
                {T.status[p]}
              </button>
            ))}
            {phone && (
              <div className="ms-auto" dir="ltr">
                <Segmented
                  value={half}
                  onChange={setHalf}
                  label={T.halfMouth}
                  options={[
                    { key: "right", label: T.patientRight },
                    { key: "left", label: T.patientLeft },
                  ]}
                />
              </div>
            )}
          </div>

          {/* The mouth */}
          <div className="mt-3" dir="ltr" onTouchStart={phone ? onTouchStart : undefined} onTouchEnd={phone ? onTouchEnd : undefined}>
            <div className="mb-1 flex items-center justify-between px-1 text-[11px] font-semibold text-ink-400">
              <span>{!phone || half === "right" ? `◀ ${T.patientRight}` : ""}</span>
              <span>{T.upper}</span>
              <span>{!phone || half === "left" ? `${T.patientLeft} ▶` : ""}</span>
            </div>
            <Odontogram
              dentition={dentition}
              states={states}
              visible={visible}
              selected={mode === "tooth" ? selected : []}
              half={phone ? half : null}
              locale={locale}
              brush={mode === "brush"}
              highlight={mouthHover}
              onTooth={onTooth}
              onSurface={onSurface}
              categoryOf={categoryOf}
            />
            <div className="mt-1 text-center text-[11px] font-semibold text-ink-400">{T.lower}</div>
          </div>

          {/*
            Whole mouth: work that belongs to no single tooth, each as a small
            mouth with the part it covers lit — the whole mouth, an arch, a
            quadrant. Pointing at one outlines the same part of the chart above;
            tapping it opens the entry.
          */}
          <section className="mt-4" aria-label={T.wholeMouth}>
            <h4 className="mb-2 text-[13px] font-semibold text-ink-900">{T.wholeMouth}</h4>
            <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
              {mouthMarks.map((m) => {
                const p = paintAt(m, at)!;
                const region = m.site as MouthRegion;
                const point = () => setMouthHover(region);
                const unpoint = () => setMouthHover(null);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMouthEntry(m.id)}
                    onMouseEnter={point}
                    onMouseLeave={unpoint}
                    onFocus={point}
                    onBlur={unpoint}
                    data-mouth-mark={m.treatmentKey}
                    className="flex w-[15.5rem] shrink-0 snap-start items-center gap-3 rounded-card border bg-surface p-2 pe-3 text-start transition-shadow duration-140 hover:shadow-pop"
                    style={{ borderColor: SOFT[p] }}
                  >
                    <MouthGlyph region={region} paint={p} icon={iconFor(categoryOf(m.treatmentKey))} size={72} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-semibold text-ink-900">{locale === "ar" ? m.labelAr : m.label}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-ink-500">{siteLabel(m.site, T)}</span>
                      <span className="mt-1 flex items-center gap-1.5">
                        <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: SOFT[p], color: INK[p] }}>
                          {T.status[p]}
                        </span>
                        <span className="text-[11.5px] text-ink-500 tnum">{fmtDateOnly(m.doneAt ?? m.createdAt, locale)}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
              {!past && (
                <button
                  type="button"
                  onClick={() => setMouthOpen(true)}
                  className="flex w-[15.5rem] shrink-0 snap-start items-center gap-3 rounded-card border border-dashed border-line-strong bg-surface p-2 pe-3 text-start transition-colors duration-140 hover:bg-sunken"
                >
                  <MouthGlyph region={null} paint={null} icon={Plus} size={72} />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold text-brand-600">{T.addWholeMouth}</span>
                    {mouthMarks.length === 0 && <span className="mt-0.5 block text-[12px] leading-snug text-ink-500">{T.nothingWholeMouth}</span>}
                  </span>
                </button>
              )}
            </div>
          </section>

          {/* Time: the mouth on any day something happened. */}
          {days.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-ctl bg-canvas px-3 py-2">
              <HistoryIcon className="h-4 w-4 shrink-0 text-ink-400" />
              <input
                type="range"
                min={0}
                max={days.length}
                step={1}
                value={dayIdx ?? days.length}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDayIdx(v >= days.length ? null : v);
                }}
                aria-label={T.history}
                className="min-w-32 flex-1 accent-brand-600"
                dir="ltr"
              />
              <span className="min-w-24 text-[13px] font-semibold text-ink-900 tnum" data-viewing={at === null ? "today" : days[dayIdx!]}>
                {at === null ? T.today : T.viewing.replace("{date}", dayLabel)}
              </span>
              {past && (
                <button type="button" onClick={() => setDayIdx(null)} className="text-[12.5px] font-semibold text-brand-600 hover:underline">
                  {T.backToToday}
                </button>
              )}
            </div>
          )}

          {/* "Recorded — undo": the last tap can be taken back for a few seconds. */}
          {lastAdded && (
            <div
              key={lastAdded.key}
              // Above the docked panel when it is open, so the undo is never under it.
              className={`pointer-events-none z-[46] flex justify-center animate-fade-up ${sheetOpen ? "fixed inset-x-0" : "sticky bottom-3 mt-3"}`}
              style={sheetOpen ? { bottom: `calc(${SHEET_SHARE * 100}dvh + 10px)` } : undefined}
            >
              <div className="pointer-events-auto inline-flex items-center gap-3 rounded-full bg-brand-600 py-1.5 ps-4 pe-1.5 text-[13px] text-white shadow-pop">
                <span className="max-w-[60vw] truncate">{lastAdded.text}</span>
                <button type="button" onClick={undo} className="inline-flex h-7 items-center gap-1 rounded-full bg-white/15 px-2.5 font-semibold hover:bg-white/25">
                  <Undo2 className="h-3.5 w-3.5" />
                  {T.undo}
                </button>
              </div>
            </div>
          )}
        </Card>

        {sideBySide && (
          <div className="sticky top-4 max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto rounded-card border border-line bg-surface p-4 shadow-card animate-fade-in" data-dental-panel>
            {mode === "brush" ? brushPickerBody : panel}
          </div>
        )}
      </div>

      {!wide && (
        <DockSheet open={!!panel} label={selected.length === 1 ? T.tooth.replace("{n}", selected[0]) : T.onTooth}>
          {panel || null}
        </DockSheet>
      )}
      {!wide && (
        <Modal open={brushPicker} onClose={() => setBrushPicker(false)} title={T.brushPick}>
          {brushPickerBody}
        </Modal>
      )}

      {/* A whole-mouth entry, opened from its card: the same row a tooth's entries use. */}
      <Modal open={!!mouthEntry} onClose={() => setMouthEntry(null)} title={T.wholeMouth}>
        {(() => {
          const m = marks.find((x) => x.id === mouthEntry);
          if (!m) return null;
          return (
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <MouthGlyph region={m.site as MouthRegion} paint={paintAt(m, null) ?? "existing"} icon={iconFor(categoryOf(m.treatmentKey))} size={96} />
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-ink-900">{locale === "ar" ? m.labelAr : m.label}</div>
                  <div className="text-[13px] text-ink-500">{siteLabel(m.site, T)}</div>
                </div>
              </div>
              <ul>
                <EntryRow
                  m={m}
                  custom={custom}
                  doctors={roster}
                  tz={tz}
                  canEdit={!past}
                  onMarkDone={actions.onMarkDone}
                  onVoid={(x) => {
                    setMouthEntry(null);
                    actions.onVoid(x);
                  }}
                  onNote={actions.onNote}
                  onDetail={actions.onDetail}
                  onPerformer={actions.onEntryPerformer}
                />
              </ul>
            </div>
          );
        })()}
      </Modal>

      {/* Room to scroll the last of the page out from under the docked panel. */}
      {sheetOpen && <div aria-hidden style={{ height: `${SHEET_SHARE * 100}dvh` }} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 font-display text-base font-semibold text-ink-900">
            {T.remaining}
            {remaining.length > 0 && <span className="ms-2 rounded-full bg-sunken px-2 py-0.5 text-[12px] text-ink-500 tnum">{remaining.length}</span>}
          </h3>
          {remaining.length === 0 ? (
            <p className="text-[13px] text-ink-500">{T.noRemaining}</p>
          ) : (
            <ul className="grid gap-2">
              {remaining.map((m) => (
                <li key={m.id} className="grid grid-cols-[2.75rem_1fr] items-start gap-2">
                  <span className="mt-2.5 text-center text-[13px] font-bold text-ink-700 tnum">{isToothSite(m.site) ? m.site : "—"}</span>
                  <ul>
                  <EntryRow
                    m={m}
                    custom={custom}
                    doctors={roster}
                    tz={tz}
                    canEdit={!past}
                    onMarkDone={actions.onMarkDone}
                    onVoid={actions.onVoid}
                    onNote={actions.onNote}
                    onDetail={actions.onDetail}
                    onPerformer={actions.onEntryPerformer}
                  />
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-semibold text-ink-900">{T.history}</h3>
            <select value={historyDoctor} onChange={(e) => setHistoryDoctor(e.target.value)} className="select-chevron h-9 appearance-none rounded-ctl border border-line bg-surface ps-3 pe-8 text-base md:text-sm">
              <option value="">{T.allDoctors}</option>
              {roster.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="max-h-[28rem] overflow-y-auto pe-1">
            <EventList events={historyEvents} marks={marks} tz={tz} showSite />
          </div>
        </Card>
      </div>

      {/* Whole mouth: the picker, then — for an arch or a quadrant — where. */}
      <Modal
        open={mouthOpen}
        onClose={() => {
          setMouthOpen(false);
          setScoped(null);
        }}
        title={T.addWholeMouth}
      >
        {scoped ? (
          <div className="grid gap-3">
            <p className="text-[14px] font-semibold text-ink-900">
              {locale === "ar" ? scoped.ar : scoped.en} — {T.where}
            </p>
            <div className="grid grid-cols-2 gap-2" dir="ltr">
              {(scoped.scope === "arch" ? ["upper", "lower"] : ["Q1", "Q2", "Q4", "Q3"]).map((s) => (
                <Button key={s} variant="outline" onClick={() => pickWholeMouth(scoped, s)}>
                  {siteLabel(s, T)}
                </Button>
              ))}
            </div>
            <button type="button" onClick={() => setScoped(null)} className="justify-self-start text-[13px] font-semibold text-brand-600">
              {T.cancel}
            </button>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <StatusPicker value={status} onChange={setStatus} />
            </div>
            <TreatmentPicker
              catalog={catalog}
              context={null}
              favorites={favorites}
              recent={recent}
              paint={status}
              tz={tz}
              mouthOnly
              onPick={(tr) => pickWholeMouth(tr)}
              onToggleFavorite={actions.onToggleFavorite}
              onAddCustom={() => setCustomOpen(true)}
            />
          </div>
        )}
      </Modal>

      <CustomTreatmentModal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        me={me}
        onSave={(tr) => {
          setCustom((prev) => [...prev, tr]);
          setCustomOpen(false);
          toast(locale === "ar" ? tr.ar : tr.en);
        }}
      />

      <Modal open={!!voiding} onClose={() => setVoiding(null)} title={T.voidTitle}>
        {voiding && (
          <div className="grid gap-3">
            <p className="text-sm text-ink-700">{T.voidBody}</p>
            <p className="text-[13px] font-semibold text-ink-900">
              {siteLabel(voiding.site, T)} · {locale === "ar" ? voiding.labelAr : voiding.label}
            </p>
            <label className="block">
              <span className="mb-1 block text-[13px] font-semibold">{T.voidReason}</span>
              <input autoFocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className="h-10 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm" />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setVoiding(null)}>
                {T.cancel}
              </Button>
              <Button variant="danger" onClick={confirmVoid} disabled={!voidReason.trim()}>
                {T.voidConfirm}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
