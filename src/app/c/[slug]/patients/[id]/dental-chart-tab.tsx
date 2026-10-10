"use client";

/*
  The dental chart tab: the patient's own chart, saved.

  Every tap lands on the tooth at once and is stored behind it. The browser
  makes the ids, so the entry it drew and the row the server keeps are the same
  entry from the start; if the server refuses, the tooth goes back the way it
  was and says so. Nothing waits on the network to answer the finger.

  Who may record is the `patients.charts` capability. Everybody else who can
  open the file reads the chart, its history and its images, and can add an
  x-ray or photo to the file like on the Files tab.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MousePointer2, Paintbrush, History as HistoryIcon, Undo2, ChevronDown, Radiation, X } from "lucide-react";
import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { fmtDateOnly } from "@/lib/dates";
import { BORROWABLE_LOOKS, BUILT_IN, BUILT_IN_BY_KEY, PROCEDURE_CATEGORIES, findTreatment, type Category, type Look, type Scope, type Treatment } from "@/lib/charts/dental/catalog";
import { groupParents, implantSitesOf, inChartOrder, isFullArch, onImplants, parentOf, prosthesisSites } from "@/lib/charts/dental/full-arch";
import { PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, dentitionForAge, tooth as toothOf, type Arch, type Dentition, type Surface } from "@/lib/charts/dental/teeth";
import { endOfDay, eventDays, isToothSite, paintAt, toothStates, type Mark, type MarkEvent, type Paint, type Person, type Status } from "@/lib/charts/dental/state";
import type { DentalChartData } from "@/lib/charts/dental/db";
import { DentalDefs, INK, PaintSwatch, SOFT } from "@/components/charts/dental/tooth-art";
import { useDentalStore, type ChartFile } from "@/components/charts/dental/store";
import { Odontogram, neighbour, type RegionMark } from "@/components/charts/dental/odontogram";
import { ImageViewer, type ChartImage } from "@/components/charts/dental/image-viewer";
import { ImageStrip } from "@/components/charts/dental/image-strip";
import { CameraCapture } from "@/components/charts/dental/camera-capture";
import { SendToPatient, sendPictureToPatient } from "@/components/patient-files/send-to-patient";
import { MouthGlyph, type MouthRegion } from "@/components/charts/dental/mouth-art";
import { DockSheet, SHEET_SHARE } from "@/components/charts/dental/dock-sheet";
import { iconFor } from "@/components/charts/dental/icons";
import { ToothPanel, type PanelActions } from "@/components/charts/dental/tooth-panel";
import { FullArchSheet } from "@/components/charts/dental/full-arch-sheet";
import { TreatmentGlyph, TreatmentPicker } from "@/components/charts/dental/treatment-picker";
import { EntryRow, EventList } from "@/components/charts/dental/history";
import { siteLabel } from "@/components/charts/dental/labels";

const ORDER = [...PERMANENT_UPPER, ...PRIMARY_UPPER, ...PRIMARY_LOWER, ...PERMANENT_LOWER];
const siteOrder = (s: string) => {
  const i = ORDER.indexOf(s);
  return i === -1 ? -1 : i;
};
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));
const PAINTS: Paint[] = ["planned", "done", "existing", "finding"];
const STATUSES: Status[] = ["planned", "done", "existing"];

/** A JSON call to the chart's routes; throws with the server's error code. */
async function call<T = Record<string, unknown>>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? `http_${res.status}`);
  return json;
}

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

function CustomTreatmentModal({
  open,
  onClose,
  onSave,
  me,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (d: { name: string; abbr: string; category: Category; scope: Scope; look: Look }) => void;
  me: Person;
  busy: boolean;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const C = T.custom;
  const [name, setName] = useState("");
  const [abbr, setAbbr] = useState("");
  const [category, setCategory] = useState<Category>("restorative");
  const [scope, setScope] = useState<Scope>("tooth");
  const [look, setLook] = useState<Look>("dot");
  useEffect(() => {
    if (open) {
      setName("");
      setAbbr("");
    }
  }, [open]);
  const field = "h-10 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm focus:border-brand-600 focus:outline-none";
  const save = () => name.trim() && onSave({ name: name.trim(), abbr: abbr.trim(), category, scope, look });
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
          <Button onClick={save} disabled={!name.trim()} loading={busy}>
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
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={C.namePlaceholder} className={field} maxLength={80} />
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
          <label className="block">
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
        <p className="text-[12px] text-ink-500">
          {C.byline.replace("{name}", me.name)} · {fmtDateOnly(new Date(), locale)}
        </p>
      </div>
    </Modal>
  );
}

export type PatientFile = ChartFile;

/** What the patient page hands the tab: the saved chart and who is charting. */
export type DentalTabData = {
  me: Person;
  /** The signed-in member, so "performed by" starts on the doctor at the chair. */
  myMemberId: string | null;
  doctors: Person[];
  /** May this member record on the chart (`patients.charts`)? */
  canWrite: boolean;
  chart: DentalChartData;
  clinicName: string;
  /** May this member send the patient a picture on WhatsApp, and has the patient a number? */
  canMessage: boolean;
};

/*
  The entries, the history, the clinic's treatments and the patient's images
  come from the file's chart store (store.tsx), not from here: the tab is
  unmounted whenever another one is opened, and the store is not.
*/
type TabProps = {
  slug: string;
  patientId: string;
  tz: string;
  birthDate: string | null;
  data: DentalTabData;
};

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
  const { t, locale } = useI18n();
  // Words for the patient are in the clinic's language, not the chart's English.
  const caption = (dateIso: string) =>
    t.devices.xrayCaption.replace("{clinic}", props.data.clinicName).replace("{date}", fmtDateOnly(dateIso, locale));
  return (
    <I18nProvider dict={t} locale="en">
      <div dir="ltr" lang="en" className="font-sans" data-latin-island>
        <DentalChart {...props} caption={caption} />
      </div>
    </I18nProvider>
  );
}

function DentalChart({ slug, patientId, tz, birthDate, data, caption }: TabProps & { caption: (dateIso: string) => string }) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const { toast } = useToast();
  const { me, doctors: roster, canWrite } = data;
  const base = `/api/c/${slug}/patients/${patientId}/dental/marks`;

  const { marks, setMarks, events, setEvents, favorites, setFavorites, custom, setCustom, files: allFiles, setFiles, pins, setPins, write } = useDentalStore();
  const [customBusy, setCustomBusy] = useState(false);

  const [selected, setSelected] = useState<string[]>([]);
  const [picked, setPicked] = useState<Surface[]>([]);
  const [flash, setFlash] = useState(false);
  const [mode, setMode] = useState<"tooth" | "brush">("tooth");
  const [brush, setBrush] = useState<Treatment | null>(null);
  const [brushPicker, setBrushPicker] = useState(false);
  const [status, setStatus] = useState<Status>("done");
  // The doctor at the chair if the person charting is one, otherwise the first doctor.
  const [performer, setPerformer] = useState(() => roster.find((d) => d.id === data.myMemberId)?.id ?? roster[0]?.id ?? "");
  const [dentition, setDentition] = useState<Dentition>(() => dentitionForAge(birthDate));
  const [half, setHalf] = useState<"right" | "left">("right");
  const [show, setShow] = useState<Record<Paint, boolean>>({ planned: true, done: true, existing: true, finding: true });
  const [dayIdx, setDayIdx] = useState<number | null>(null);
  const [span, setSpan] = useState<Treatment | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(false);
  const [scoped, setScoped] = useState<Treatment | null>(null);
  /** A full arch being set up: which treatment, and the arch when a tooth already said it. */
  const [fullArch, setFullArch] = useState<{ tr: Treatment; arch: Arch | null } | null>(null);
  const [voiding, setVoiding] = useState<Mark | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [lastAdded, setLastAdded] = useState<{ ids: string[]; text: string; key: number } | null>(null);
  const [historyDoctor, setHistoryDoctor] = useState("");
  /** A region label being pointed at, and the entry opened from one. */
  const [mouthHover, setMouthHover] = useState<MouthRegion | null>(null);
  const [mouthEntry, setMouthEntry] = useState<string | null>(null);

  /*
    X-rays and photos: the patient's own files of those kinds, newest first —
    the same files the Files tab lists. Which teeth each shows is a label on
    the file (`patient_files.teeth`).
  */
  const images = useMemo<ChartImage[]>(
    () =>
      allFiles
        // A DICOM the server could not draw is on the Files tab with its original, not here.
        .filter((f) => (f.kind === "xray" || f.kind === "photo" || f.mime_type.startsWith("image/")) && f.kind !== "insurance_card" && f.mime_type !== "application/dicom")
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map<ChartImage>((f) => ({
          id: f.id,
          src: `/api/c/${slug}/files/${f.id}`,
          name: f.file_name,
          kind: f.kind === "xray" || f.kind === "photo" ? f.kind : "other",
          mime: f.mime_type,
          date: f.created_at,
        })),
    [allFiles, slug]
  );
  const [viewer, setViewer] = useState<{ list: ChartImage[]; index: number } | null>(null);
  const [sending, setSending] = useState<{ img: ChartImage; caption: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [camera, setCamera] = useState<{ tooth?: string } | null>(null);
  /** A "Take x-ray" request waiting on the imaging station. */
  const [pending, setPending] = useState<{ id: string; teeth: string[] } | null>(null);

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
  const locked = past || !canWrite;
  const states = useMemo(() => toothStates(marks, at), [marks, at]);
  const visible = useCallback((p: Paint) => show[p], [show]);
  const catalog = useMemo(() => [...BUILT_IN, ...custom], [custom]);
  const categoryOf = useCallback((key: string) => findTreatment(key, custom)?.category, [custom]);
  const performerPerson = roster.find((d) => d.id === performer) ?? null;
  // What this person used lately, newest first: learned from the chart, not stored.
  const recent = useMemo(
    () => uniq([...marks].filter((m) => m.recordedBy.id === me.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((m) => m.treatmentKey)).slice(0, 8),
    [marks, me.id]
  );

  /*
    Work on the mouth, an arch or a quadrant, as the chart labels it on the day
    shown. Memoised on purpose: the chart lays its bands out from this list,
    and a new list every render would redraw every tooth on every tap.
  */
  const parents = useMemo(() => groupParents(marks), [marks]);
  /** "All-on-4", "Overdenture on 2 implants": a full arch as dentists name it, from the implants it holds. */
  const fullArchName = useCallback(
    (m: Mark) => {
      const n = implantSitesOf(m, marks).length || Number(m.detail.implants) || 0;
      if (!n) return locale === "ar" ? m.labelAr : m.label;
      return n >= 4 ? `All-on-${n}` : T.overdenture.replace("{n}", String(n));
    },
    [marks, locale, T]
  );
  /** The line under a full arch's name: how many implants and where, and the extractions it includes. */
  const groupExtra = (m: Mark) => {
    if (!isFullArch(m.treatmentKey) || !m.groupId) return undefined;
    const sites = implantSitesOf(m, marks);
    const out = marks.filter((x) => x.groupId === m.groupId && x.id !== m.id && !x.voidedAt && x.look === "extraction").length;
    const parts = [
      sites.length ? T.implantsAt.replace("{n}", String(sites.length)).replace("{list}", sites.join(" · ")) : "",
      out ? T.withExtractions.replace("{n}", String(out)) : "",
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : undefined;
  };

  const regionMarks = useMemo<RegionMark[]>(
    () =>
      marks
        .filter((m) => !isToothSite(m.site))
        .flatMap((m) => {
          const paint = paintAt(m, at);
          if (!paint || !visible(paint)) return [];
          const label = m.treatmentKey === "implant_denture" && m.groupId ? fullArchName(m) : locale === "ar" ? m.labelAr : m.label;
          const when = fmtDateOnly(m.doneAt ?? m.createdAt, locale);
          return [{ id: m.id, site: m.site as MouthRegion, label, title: `${label} · ${siteLabel(m.site, T)} · ${T.status[paint]} · ${when}`, paint, category: categoryOf(m.treatmentKey) }];
        }),
    [marks, at, visible, locale, categoryOf, T, fullArchName]
  );

  /* ── X-rays and photos ───────────────────────────────────────────────── */

  const imageCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const img of images) for (const fdi of pins[img.id] ?? []) out[fdi] = (out[fdi] ?? 0) + 1;
    return out;
  }, [images, pins]);
  const openToothImages = (fdi: string) => {
    const list = images.filter((img) => (pins[img.id] ?? []).includes(fdi));
    if (list.length) setViewer({ list, index: 0 });
  };

  /** Which teeth a file shows, saved on the file; taken back if the save fails. */
  const setTeeth = async (fileId: string, teeth: string[]) => {
    const before = pins[fileId] ?? [];
    setPins((prev) => ({ ...prev, [fileId]: teeth }));
    try {
      await write([], call(`/api/c/${slug}/files/${fileId}/teeth`, "PATCH", { teeth }));
    } catch {
      setPins((prev) => ({ ...prev, [fileId]: before }));
      toast(T.saveFailed, "error");
    }
  };
  const togglePin = (fileId: string, fdi: string) => {
    if (!canWrite) return;
    const cur = pins[fileId] ?? [];
    void setTeeth(fileId, cur.includes(fdi) ? cur.filter((x) => x !== fdi) : [...cur, fdi]);
  };

  /*
    An image goes into the patient's Files through the same route the Files
    tab uses, so it is a real file of the right kind and the Files tab lists it
    too. Added from a tooth, it comes pinned to it.
  */
  const upload = async (kind: "xray" | "photo", file: File, toTooth?: string) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("kind", kind);
      const res = await fetch(`/api/c/${slug}/patients/${patientId}/files`, { method: "POST", body: fd });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; file?: PatientFile } | null;
      if (!res.ok || !body?.file) throw new Error("upload");
      const row = body.file;
      setFiles((prev) => [row, ...prev.filter((f) => f.id !== row.id)]);
      setPins((prev) => ({ ...prev, [row.id]: [] }));
      if (toTooth && canWrite) await setTeeth(row.id, [toTooth]);
      toast(T.savedToFiles);
    } catch {
      toast(T.uploadFailed, "error");
    } finally {
      setUploading(false);
    }
  };

  /*
    "Take x-ray": arm the imaging station on the computer beside the x-ray
    machine. The next image its software saves comes into this patient's
    files, pinned to these teeth, and opens here the moment it lands.
  */
  const takeXray = async (teeth: string[]) => {
    try {
      const r = await call<{ request: { id: string } }>(`/api/c/${slug}/imaging/requests`, "POST", { patientId, teeth, kind: "xray" });
      setPending({ id: r.request.id, teeth });
    } catch {
      toast(T.saveFailed, "error");
    }
  };
  const cancelXray = async () => {
    if (!pending) return;
    const id = pending.id;
    setPending(null);
    await call(`/api/c/${slug}/imaging/requests/${id}`, "POST", { op: "cancel" }).catch(() => {});
  };
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/c/${slug}/imaging/requests/${pending.id}`);
        const body = (await res.json()) as { request?: { fulfilledAt: string | null; cancelledAt: string | null }; file?: PatientFile & { teeth: string[] } | null };
        if (stop) return;
        if (body.request?.cancelledAt) {
          setPending(null);
          return;
        }
        if (body.request?.fulfilledAt && body.file) {
          const f = body.file;
          setFiles((prev) => [f, ...prev.filter((x) => x.id !== f.id)]);
          setPins((prev) => ({ ...prev, [f.id]: f.teeth ?? [] }));
          setPending(null);
          toast(T.xrayArrived);
          setViewer({
            list: [{ id: f.id, src: `/api/c/${slug}/files/${f.id}`, name: f.file_name, kind: "xray", mime: f.mime_type, date: f.created_at }],
            index: 0,
          });
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
    };
    const id = setInterval(tick, 2500);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [pending, slug, T.xrayArrived, toast]);

  /* ── Recording ───────────────────────────────────────────────────────── */

  const defaultsFor = (tr: Treatment, site: string): Record<string, string> => {
    const d: Record<string, string> = {};
    for (const f of tr.details ?? []) {
      d[f.key] = f.key === "canals" && isToothSite(site) ? String(toothOf(site).roots) : f.options[0].key;
    }
    return d;
  };

  const removeLocal = (ids: Set<string>) => {
    setMarks((prev) => prev.filter((m) => !ids.has(m.id)));
    setEvents((prev) => prev.filter((e) => !ids.has(e.markId)));
  };
  /** Put the server's rows in place of the ones drawn ahead of it. */
  const settle = (rows: Mark[], evs: MarkEvent[]) => {
    const byId = new Map(rows.map((m) => [m.id, m]));
    setMarks((prev) => prev.map((m) => byId.get(m.id) ?? m));
    const evIds = new Set(evs.map((e) => e.id));
    setEvents((prev) => [...prev.filter((e) => !evIds.has(e.id)), ...evs]);
  };

  /*
    One tap can record more than one treatment: a full arch is the arch, an
    implant on each tooth that carries one, a bridge tooth on each it
    replaces, and the extractions that come first. A site may name its own
    treatment and details, and stay out of the group (`group: false`).
  */
  type Site = { site: string; surfaces: Surface[]; role?: Mark["role"]; tr?: Treatment; detail?: Record<string, string>; group?: boolean };

  const record = (tr: Treatment, sites: Site[], groupId?: string, text?: string) => {
    const now = new Date().toISOString();
    const fresh: (Mark & { eventId: string })[] = sites.map((s) => {
      const t = s.tr ?? tr;
      const st: Status = t.kind === "finding" ? "existing" : status;
      return {
        id: newId(),
        eventId: newId(),
        site: s.site,
        surfaces: s.surfaces,
        treatmentKey: t.key,
        label: t.en,
        labelAr: t.ar,
        abbr: t.abbr,
        look: t.look,
        kind: t.kind,
        detail: s.detail ?? defaultsFor(t, s.site),
        status: st,
        groupId: s.group === false ? undefined : groupId,
        role: s.role,
        performedBy: performerPerson,
        recordedBy: me,
        createdAt: now,
        doneAt: st === "done" ? now : null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        note: "",
      };
    });
    setMarks((prev) => [...prev, ...fresh.map(({ eventId: _e, ...m }) => m)]);
    setEvents((prev) => [...prev, ...fresh.map((m) => ({ id: m.eventId, markId: m.id, action: "created" as const, at: now, by: me }))]);
    const where = sites.map((s) => (isToothSite(s.site) ? s.site : siteLabel(s.site, T))).join(" · ");
    setLastAdded({ ids: fresh.map((m) => m.id), text: text ?? T.added.replace("{name}", locale === "ar" ? tr.ar : tr.en).replace("{site}", where), key: Date.now() });
    write(
      fresh.map((m) => m.id),
      call<{ marks: Mark[]; events: MarkEvent[] }>(base, "POST", {
      marks: fresh.map((m) => ({
        id: m.id,
        eventId: m.eventId,
        site: m.site,
        surfaces: m.surfaces,
        treatmentKey: m.treatmentKey,
        detail: m.detail,
        status: m.status,
        groupId: m.groupId ?? null,
        role: m.role ?? null,
        performedBy: m.performedBy?.id ?? null,
      })),
      })
    )
      .then((r) => settle(r.marks, r.events))
      .catch(() => {
        removeLocal(new Set(fresh.map((m) => m.id)));
        setLastAdded(null);
        toast(T.saveFailed, "error");
      });
  };

  /** Take entries back: a mis-tap, within two minutes, by whoever made it. */
  const unrecord = async (ids: string[]) => {
    const gone = marks.filter((m) => ids.includes(m.id));
    const evs = events.filter((e) => ids.includes(e.markId));
    removeLocal(new Set(ids));
    const failed: string[] = [];
    for (const id of ids) await write([id], call(`${base}/${id}`, "DELETE")).catch(() => failed.push(id));
    if (failed.length) {
      setMarks((prev) => [...prev, ...gone.filter((m) => failed.includes(m.id))]);
      setEvents((prev) => [...prev, ...evs.filter((e) => failed.includes(e.markId))]);
      toast(T.undoTooLate, "error");
    }
  };
  const undo = () => {
    if (!lastAdded) return;
    void unrecord(lastAdded.ids);
    setLastAdded(null);
  };

  /*
    A change to an entry: drawn now, stored behind it, and put back exactly as
    it was if the server says no. The history line, when the change has one,
    is drawn too and replaced by the server's.
  */
  const change = (m: Mark, next: Mark, body: Record<string, unknown>, action?: MarkEvent["action"], reason?: string) => {
    const eventId = action ? newId() : null;
    // A whole-arch entry's teeth follow it when it is done or voided; the server does the same.
    const op = body.op;
    const kids =
      (op === "done" || op === "void") && m.groupId && !isToothSite(m.site)
        ? marks.filter((x) => x.groupId === m.groupId && x.id !== m.id && !x.voidedAt && (op === "void" || x.status === "planned"))
        : [];
    const kidIds = new Set(kids.map((x) => x.id));
    const kidNext = (x: Mark): Mark =>
      op === "done" ? { ...x, status: "done", doneAt: next.doneAt } : { ...x, voidedAt: next.voidedAt, voidedBy: next.voidedBy, voidReason: next.voidReason };
    setMarks((prev) => prev.map((x) => (x.id === m.id ? next : kidIds.has(x.id) ? kidNext(x) : x)));
    if (action && eventId) setEvents((prev) => [...prev, { id: eventId, markId: m.id, action, at: new Date().toISOString(), by: me, reason }]);
    write(
      [m.id, ...kidIds],
      call<{ mark: Mark; event: MarkEvent | null; also?: Mark[]; alsoEvents?: MarkEvent[] }>(`${base}/${m.id}`, "PATCH", eventId ? { ...body, eventId } : body)
    )
      .then((r) => settle([r.mark, ...(r.also ?? [])], [...(r.event ? [r.event] : []), ...(r.alsoEvents ?? [])]))
      .catch(() => {
        setMarks((prev) => prev.map((x) => (x.id === m.id ? m : kids.find((k) => k.id === x.id) ?? x)));
        if (eventId) setEvents((prev) => prev.filter((e) => e.id !== eventId));
        toast(T.saveFailed, "error");
      });
  };
  const find = (id: string) => marks.find((m) => m.id === id);

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

  /*
    A full arch: the arch itself, an implant on each tooth that carries one, a
    bridge or denture tooth on each it replaces and — when it is still to come
    — the extractions of the teeth standing in the arch. One group, so the
    chart draws the work on the teeth, the lists show it once, and the day it
    is done every part of it is: the extractions are that same surgery, not a
    page of separate rows to tick off one by one.
  */
  const recordFullArch = (tr: Treatment, arch: Arch, implants: string[], extract: string[]) => {
    const implantTr = BUILT_IN_BY_KEY.get("implant")!;
    const extractionTr = BUILT_IN_BY_KEY.get("extraction")!;
    const implanted = onImplants(tr.key);
    const sites: Site[] = [
      { site: arch, surfaces: [], detail: implanted ? { implants: String(implants.length) } : defaultsFor(tr, arch) },
      ...implants.map((f) => ({ site: f, surfaces: [] as Surface[], role: "abutment" as const, tr: implantTr, detail: {} })),
      ...prosthesisSites(tr.key, arch, implants.length).map((f) => ({ site: f, surfaces: [] as Surface[], role: "pontic" as const, detail: {} })),
      ...extract.map((f) => ({ site: f, surfaces: [] as Surface[], tr: extractionTr, detail: {} })),
    ];
    const where = implanted
      ? `${siteLabel(arch, T)} · ${T.implantsAt.replace("{n}", String(implants.length)).replace("{list}", inChartOrder(implants).join(" · "))}`
      : siteLabel(arch, T);
    record(tr, sites, newId(), T.added.replace("{name}", locale === "ar" ? tr.ar : tr.en).replace("{site}", where));
    setFullArch(null);
    closePanel();
  };

  const pick = (tr: Treatment) => {
    if (locked || selected.length === 0) return;
    if (isFullArch(tr.key)) {
      setFullArch({ tr, arch: toothOf(selected[0]).arch });
      return;
    }
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
    if (!brush || locked) return;
    const tr = brush;
    const prior = [...marks]
      .reverse()
      .find((m) => !m.voidedAt && m.site === fdi && m.treatmentKey === tr.key && m.recordedBy.id === me.id && Date.now() - Date.parse(m.createdAt) < 60_000);
    if (tr.needsSurfaces) {
      const sf = s ?? "O";
      if (prior) {
        const next = prior.surfaces.includes(sf) ? prior.surfaces.filter((x) => x !== sf) : [...prior.surfaces, sf];
        if (next.length === 0) void unrecord([prior.id]);
        else change(prior, { ...prior, surfaces: next }, { op: "surfaces", surfaces: next });
        return;
      }
      record(tr, [{ site: fdi, surfaces: [sf] }]);
      return;
    }
    if (prior) {
      void unrecord([prior.id]);
      return;
    }
    record(tr, [{ site: fdi, surfaces: [] }]);
  };

  const onTooth = (fdi: string, additive: boolean) => {
    if (mode === "brush") {
      if (!brush) setBrushPicker(true);
      else paint(fdi, null);
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
      else paint(fdi, s);
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

  const toggleFavorite = (key: string) => {
    if (!canWrite) return;
    const on = !favorites.some((f) => f.key === key);
    const before = favorites;
    setFavorites(on ? [...favorites, { key, addedBy: me, addedAt: new Date().toISOString() }] : favorites.filter((f) => f.key !== key));
    write([], call(`/api/c/${slug}/dental/favorites`, "POST", { key, on })).catch(() => {
      setFavorites(before);
      toast(T.saveFailed, "error");
    });
  };

  const actions: PanelActions = {
    onTogglePicked: togglePicked,
    onStatus: setStatus,
    onPerformer: setPerformer,
    onPick: pick,
    onToggleFavorite: toggleFavorite,
    onAddCustom: () => setCustomOpen(true),
    onSpanRecord: () => span && recordSpan(span, selected),
    onSpanCancel: () => setSpan(null),
    onMarkDone: (id) => {
      const m = find(id);
      if (m) change(m, { ...m, status: "done", doneAt: new Date().toISOString() }, { op: "done" }, "done");
    },
    onVoid: (m) => {
      setVoidReason("");
      setVoiding(m);
    },
    onNote: (id, note) => {
      const m = find(id);
      if (m) change(m, { ...m, note }, { op: "note", note }, "note");
    },
    onDetail: (id, key, value) => {
      const m = find(id);
      if (m) change(m, { ...m, detail: { ...m.detail, [key]: value } }, { op: "detail", key, value });
    },
    onEntryPerformer: (id, pid) => {
      const m = find(id);
      const who = roster.find((d) => d.id === pid);
      if (m && who) change(m, { ...m, performedBy: who }, { op: "performer", performerId: pid }, "performer");
    },
    onOpenImages: (list, index) => setViewer({ list, index }),
    onPinImage: (imageId, fdi) => togglePin(imageId, fdi),
    onUploadForTooth: (kind, file, fdi) => upload(kind, file, fdi),
    onTakeXray: (fdi) => void takeXray([fdi]),
    onCamera: (fdi) => setCamera({ tooth: fdi }),
    onOpenEntry: (id) => setMouthEntry(id),
    onClose: closePanel,
  };

  const confirmVoid = () => {
    if (!voiding || !voidReason.trim()) return;
    const reason = voidReason.trim();
    change(voiding, { ...voiding, voidedAt: new Date().toISOString(), voidedBy: me, voidReason: reason }, { op: "void", reason }, "void", reason);
    setVoiding(null);
  };

  const pickWholeMouth = (tr: Treatment, site?: string) => {
    if (isFullArch(tr.key)) {
      setScoped(null);
      setMouthOpen(false);
      setFullArch({ tr, arch: site === "upper" || site === "lower" ? site : null });
      return;
    }
    if (tr.scope === "mouth" || site) {
      record(tr, [{ site: site ?? "mouth", surfaces: [] }]);
      setScoped(null);
      setMouthOpen(false);
      return;
    }
    setScoped(tr);
  };

  const addCustom = async (d: { name: string; abbr: string; category: Category; scope: Scope; look: Look }) => {
    setCustomBusy(true);
    try {
      const r = await write([], call<{ treatment: Treatment }>(`/api/c/${slug}/dental/treatments`, "POST", d));
      setCustom((prev) => [...prev, r.treatment]);
      setCustomOpen(false);
      toast(r.treatment.en);
    } catch {
      toast(T.saveFailed, "error");
    } finally {
      setCustomBusy(false);
    }
  };

  /* ── What the screen shows ───────────────────────────────────────────── */

  const live = marks.filter((m) => !m.voidedAt);
  const remaining = live.filter((m) => m.status === "planned" && !parentOf(m, parents)).sort((a, b) => siteOrder(a.site) - siteOrder(b.site));
  // The mouth's history lists a full arch once; each of its teeth keeps its own lines in that tooth's history.
  const byMark = new Map(marks.map((m) => [m.id, m]));
  const historyEvents = events.filter((e) => {
    const m = byMark.get(e.markId);
    if (!m || parentOf(m, parents)) return false;
    return !historyDoctor || m.performedBy?.id === historyDoctor;
  });

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
      canWrite={canWrite}
      tz={tz}
      images={images}
      pins={pins}
      uploading={uploading}
      parentOf={(m) => parentOf(m, parents)}
      parentName={(m) => (m.treatmentKey === "implant_denture" ? fullArchName(m) : locale === "ar" ? m.labelAr : m.label)}
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
        onToggleFavorite={toggleFavorite}
        onAddCustom={() => setCustomOpen(true)}
      />
    </div>
  );

  const dayLabel = at === null ? T.today : fmtDateOnly(days[dayIdx!], locale);
  const sideBySide = wide && ((mode === "brush" && canWrite) || !!panel);

  return (
    <div ref={wrapRef} className="grid gap-4" data-dental-chart data-can-write={canWrite || undefined}>
      <DentalDefs />

      {/*
        The chart has the whole width until there is something to hold beside
        it: a tooth being worked on, or the brush's treatments. An empty panel
        would only make every tooth smaller.
      */}
      <div className={sideBySide ? "grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4" : "grid gap-4"}>
        <Card className="relative p-3 sm:p-4">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && (
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
            )}
            {mode === "brush" && canWrite && (
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
          {!canWrite && <p className="mt-2 text-[12.5px] text-ink-500" data-read-only>{T.readOnly}</p>}

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

          {/* "Take x-ray": waiting on the imaging station. */}
          {pending && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-ctl border border-brand-200 bg-brand-50 px-3 py-2" data-xray-pending>
              <span className="slim-progress w-10 shrink-0 rounded-full" aria-hidden />
              <Radiation className="h-4 w-4 shrink-0 text-brand-600" />
              <span className="min-w-0 flex-1 text-[13px] font-semibold text-ink-900">
                {pending.teeth.length ? T.waitingXray.replace("{teeth}", pending.teeth.join(" · ")) : T.waitingXrayMouth}
              </span>
              <a href={`/c/${slug}/devices`} target="_blank" rel="noreferrer" className={buttonClass({ variant: "outline", size: "sm" })}>
                {T.openStation}
              </a>
              <button type="button" onClick={cancelXray} aria-label={T.cancel} className="grid h-8 w-8 place-items-center rounded-ctl text-ink-500 hover:bg-white">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

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
              regions={regionMarks}
              addRegionLabel={locked ? null : `+ ${T.addRegion}`}
              imageCounts={imageCounts}
              imagesLabel={T.openImages}
              onTooth={onTooth}
              onSurface={onSurface}
              onImages={openToothImages}
              onRegion={(id) => (id ? setMouthEntry(id) : setMouthOpen(true))}
              onRegionHover={setMouthHover}
              categoryOf={categoryOf}
            />
            <div className="mt-1 text-center text-[11px] font-semibold text-ink-400">{T.lower}</div>
          </div>

          <ImageStrip
            images={images}
            pins={pins}
            busy={uploading}
            canAdd={!past}
            onOpen={(i) => setViewer({ list: images, index: i })}
            onFile={(kind, f) => upload(kind, f)}
            onTakeXray={canWrite && !pending ? () => void takeXray([]) : undefined}
            onCamera={() => setCamera({})}
          />

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

      {/* An entry on the mouth, an arch or a quadrant, opened from its label. */}
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
                  canEdit={!locked}
                  onMarkDone={actions.onMarkDone}
                  onVoid={(x) => {
                    setMouthEntry(null);
                    actions.onVoid(x);
                  }}
                  onNote={actions.onNote}
                  onDetail={actions.onDetail}
                  onPerformer={actions.onEntryPerformer}
                  extra={groupExtra(m)}
                />
              </ul>
            </div>
          );
        })()}
      </Modal>

      {viewer && (
        <ImageViewer
          images={viewer.list}
          index={viewer.index}
          pins={pins}
          canPin={!locked}
          onIndex={(i) => setViewer((v) => (v ? { ...v, index: i } : v))}
          onPin={togglePin}
          onClose={() => setViewer(null)}
          onSend={data.canMessage ? (img) => setSending({ img, caption: caption(img.date) }) : undefined}
        />
      )}

      {sending && (
        <SendToPatient
          img={sending.img}
          initialCaption={sending.caption}
          onClose={() => setSending(null)}
          onSend={async (text) => {
            const r = await sendPictureToPatient(slug, sending.img.id, text);
            if (r === "ok") {
              toast(t.viewer.sentWhatsApp);
              setSending(null);
            } else {
              toast(r === "no_phone" ? t.viewer.sendNoPhone : r === "whatsapp_not_connected" ? t.viewer.sendNoWhatsApp : t.viewer.sendFailed, "error");
            }
          }}
        />
      )}

      <CameraCapture open={!!camera} onClose={() => setCamera(null)} onPhoto={(f) => void upload("photo", f, camera?.tooth)} />

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
                      canEdit={!locked}
                      onMarkDone={actions.onMarkDone}
                      onVoid={actions.onVoid}
                      onNote={actions.onNote}
                      onDetail={actions.onDetail}
                      onPerformer={actions.onEntryPerformer}
                      extra={groupExtra(m)}
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
              onToggleFavorite={toggleFavorite}
              onAddCustom={() => setCustomOpen(true)}
            />
          </div>
        )}
      </Modal>

      <Modal open={!!fullArch} onClose={() => setFullArch(null)} title={fullArch ? (locale === "ar" ? fullArch.tr.ar : fullArch.tr.en) : ""}>
        {fullArch && (
          <FullArchSheet
            key={fullArch.tr.key + (fullArch.arch ?? "")}
            tr={fullArch.tr}
            initialArch={fullArch.arch}
            states={states}
            marks={marks}
            status={status}
            onStatus={setStatus}
            onRecord={(arch, implants, extract) => recordFullArch(fullArch.tr, arch, implants, extract)}
            onCancel={() => setFullArch(null)}
          />
        )}
      </Modal>

      <CustomTreatmentModal open={customOpen} onClose={() => setCustomOpen(false)} me={me} busy={customBusy} onSave={(d) => void addCustom(d)} />

      <Modal open={!!voiding} onClose={() => setVoiding(null)} title={T.voidTitle}>
        {voiding && (
          <div className="grid gap-3">
            <p className="text-sm text-ink-700">{T.voidBody}</p>
            <p className="text-[13px] font-semibold text-ink-900">
              {siteLabel(voiding.site, T)} · {locale === "ar" ? voiding.labelAr : voiding.label}
            </p>
            <label className="block">
              <span className="mb-1 block text-[13px] font-semibold">{T.voidReason}</span>
              <input autoFocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className="h-10 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm" maxLength={300} />
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
