"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { dictFor } from "@/lib/i18n/client-dict";
import { ConfirmDialog } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { renderSystemMessage } from "@/lib/system-messages";
import { fmtDate } from "@/lib/dates";
import {
  RX_CHIPS,
  cleanItems,
  emptyItem,
  firstName,
  formatMedicineLines,
  itemDetail,
  switchItemLanguage,
  type PrescriptionRow,
  type RxChip,
  type RxItem,
  type RxLocale,
} from "@/lib/prescriptions";
import {
  createPrescriptionAction,
  deleteTemplateAction,
  saveTemplateAction,
  setMedicationHiddenAction,
  type TemplateRow,
} from "./prescription-actions";
import {
  ArrowLeft,
  BookmarkPlus,
  Eye,
  EyeOff,
  FileText,
  Plus,
  Printer,
  Send,
  Settings2,
  Trash2,
  X,
} from "lucide-react";

/*
  The prescription composer.

  Built around one question — how few taps does a routine prescription take —
  because the doctor writes it between patients, often on a tablet, and a form
  that asks for typing where a tap would do is a form that goes back to paper.

    - A template fills the whole prescription in one tap.
    - Picking a medicine the clinic has prescribed before fills its dose, how
      often and how long, the way it was written last time.
    - Every one of those has one-tap answers under it; typing is the fallback,
      not the path.
    - Repeat on an old prescription opens this already filled in.

  The clinic's list, its templates and its doctors are fetched while the patient
  file is idle (`useComposerData`), so the composer opens with nothing to wait
  for and the autocomplete filters in the browser.
*/

export type ComposerDoctor = {
  member_id: string;
  name: string;
  is_doctor: boolean;
  is_me: boolean;
  has_signature: boolean;
};

export type ComposerMedication = {
  id: string;
  name: string;
  dose: string;
  frequency: string;
  duration: string;
  instructions: string;
  use_count: number;
  hidden: boolean;
};

export type ComposerData = {
  doctors: ComposerDoctor[];
  medications: ComposerMedication[];
  templates: TemplateRow[];
  lastDoctor: string | null;
  captions: { ar: string; en: string };
  clinic: { name: string; nameAr: string | null; defaultLocale: RxLocale; timezone: string };
};

/** What the composer opens with: nothing, or an old prescription to repeat. */
export type RxDraft = {
  locale?: RxLocale;
  diagnosis?: string;
  items?: RxItem[];
  doctorMemberId?: string | null;
};

const LOCALE_KEY = "clinicos:rx-locale";

function storedLocale(): RxLocale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return v === "ar" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The composer's data, fetched once the page has gone quiet.
 *
 * Idle rather than on mount so it never competes with the file itself for the
 * first paint, and early enough that by the time anybody presses Prescription
 * it is already here. `load` is also called on open, for the press that beats
 * the idle callback, and after each save so the list has learned the new
 * medicines.
 */
export function useComposerData(slug: string, patientId: string, enabled: boolean) {
  const [data, setData] = useState<ComposerData | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const load = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const p = fetch(`/api/c/${slug}/prescriptions/composer?patient=${patientId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ComposerData | null) => {
        if (d) setData(d);
      })
      .catch(() => {})
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, [slug, patientId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => void load(), { timeout: 3000 });
      return () => w.cancelIdleCallback?.(h);
    }
    const h = setTimeout(() => void load(), 800);
    return () => clearTimeout(h);
  }, [enabled, load]);

  return { data, setData, load };
}

/** Folds the forms a name can be typed in, so "amox" finds "Amoxicillin" and احمد finds أحمد. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ً-ْـ]/g, "")
    .trim();
}

export function PrescriptionComposer({
  slug,
  patient,
  tz,
  draft,
  data,
  setData,
  reload,
  onClose,
  onSaved,
}: {
  slug: string;
  patient: { id: string; full_name: string; phone_e164: string | null };
  tz: string;
  draft: RxDraft | null;
  data: ComposerData | null;
  setData: (fn: (d: ComposerData | null) => ComposerData | null) => void;
  reload: () => Promise<void>;
  onClose: () => void;
  onSaved: (row: PrescriptionRow, warning: string | undefined, sent: boolean) => void;
}) {
  const { t, locale: uiLocale } = useI18n();
  const T = t.prescriptions;
  const { toast } = useToast();

  // Opened before the idle fetch landed: ask now.
  useEffect(() => {
    if (!data) void reload();
  }, [data, reload]);

  const [locale, setLocale] = useState<RxLocale>(
    () => draft?.locale ?? storedLocale() ?? data?.clinic.defaultLocale ?? (uiLocale === "en" ? "en" : "ar")
  );
  const [doctorId, setDoctorId] = useState<string | null>(draft?.doctorMemberId ?? null);
  const [diagnosis, setDiagnosis] = useState(draft?.diagnosis ?? "");
  const [items, setItems] = useState<RxItem[]>(() =>
    draft?.items?.length ? draft.items.map((i) => ({ ...emptyItem(), ...i })) : [emptyItem()]
  );
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<"send" | "print" | null>(null);
  const [view, setView] = useState<"form" | "manage">("form");
  const [showPreview, setShowPreview] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplSaving, setTplSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /*
    The prescriber. The person writing, when they are a doctor; otherwise
    whoever saw this patient last, which is who an assistant is almost always
    typing for; otherwise the clinic's doctor, of whom there is usually one.
    Chosen once the list arrives and never again, so it cannot move under
    somebody who has already picked.
  */
  useEffect(() => {
    if (!data || (doctorId && data.doctors.some((d) => d.member_id === doctorId))) return;
    const ds = data.doctors;
    const pick =
      ds.find((d) => d.is_me && d.is_doctor) ??
      ds.find((d) => d.member_id === data.lastDoctor) ??
      ds.find((d) => d.is_doctor) ??
      ds.find((d) => d.is_me) ??
      ds[0];
    if (pick) setDoctorId(pick.member_id);
  }, [data, doctorId]);

  const doctor = data?.doctors.find((d) => d.member_id === doctorId) ?? null;

  /*
    Dirty means different from how it opened, not merely non-empty: pressing
    Repeat and then changing one's mind should close without a question.
  */
  const opened = useRef(JSON.stringify({ diagnosis, items }));
  const dirty = JSON.stringify({ diagnosis, items }) !== opened.current;

  const requestClose = () => {
    if (pending || confirmDiscard) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  /* ------------------------------------------------------------ editing */

  const setField = (i: number, field: keyof RxItem, value: string) =>
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, [field]: value } : it)));

  const other = (l: RxLocale): RxLocale => (l === "ar" ? "en" : "ar");

  const pickMedicine = (i: number, m: ComposerMedication) => {
    // What it was prescribed with last time may have been in the other
    // language; tapped answers come across, typed ones stay as they were.
    const last = switchItemLanguage(
      { name: m.name, dose: m.dose, frequency: m.frequency, duration: m.duration, instructions: m.instructions },
      other(locale),
      locale
    );
    setItems((prev) =>
      prev.map((it, j) =>
        j === i
          ? {
              name: m.name,
              dose: it.dose || last.dose,
              frequency: it.frequency || last.frequency,
              duration: it.duration || last.duration,
              instructions: it.instructions || last.instructions,
            }
          : it
      )
    );
  };

  const [focusRow, setFocusRow] = useState<number | null>(null);
  const addRow = () => {
    setItems((prev) => [...prev, emptyItem()]);
    setActive(items.length);
    setFocusRow(items.length);
  };
  const removeRow = (i: number) => {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [emptyItem()]));
    setActive((a) => (a >= i ? Math.max(0, a - 1) : a));
  };

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRow === null) return;
    const el = listRef.current?.querySelector<HTMLInputElement>(`[data-rx-name="${focusRow}"]`);
    el?.focus();
    setFocusRow(null);
  }, [focusRow]);

  /*
    The cursor starts on the first medicine on a keyboard. On a touch screen it
    does not: the on-screen keyboard would cover the templates, which are the
    faster way in.
  */
  useEffect(() => {
    if (draft?.items?.length) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    const h = setTimeout(() => setFocusRow(0), 50);
    return () => clearTimeout(h);
  }, [draft]);

  /** Enter moves along the fields, and off the last one it starts the next medicine. */
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    if (!target.matches("[data-rx-input]")) return;
    e.preventDefault();
    const all = Array.from(listRef.current?.querySelectorAll<HTMLInputElement>("[data-rx-input]") ?? []);
    const at = all.indexOf(target as HTMLInputElement);
    if (at >= 0 && at < all.length - 1) all[at + 1].focus();
    else addRow();
  };

  const switchLocale = (next: RxLocale) => {
    if (next === locale) return;
    setItems((prev) => prev.map((it) => switchItemLanguage(it, locale, next)));
    setLocale(next);
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {}
  };

  const applyTemplate = (tpl: TemplateRow) => {
    const fromTpl = tpl.items.map((i) => switchItemLanguage({ ...emptyItem(), ...i }, tpl.locale, locale));
    const kept = items.filter((i) => i.name.trim());
    // Onto an empty prescription it is the prescription; onto one already
    // started it adds, because replacing what a doctor typed is never the
    // intent of a tap.
    setItems(kept.length ? [...kept, ...fromTpl] : fromTpl);
    if (!diagnosis.trim() && tpl.diagnosis) setDiagnosis(tpl.diagnosis);
    setTemplateId(tpl.id);
    setActive(kept.length);
  };

  /* ------------------------------------------------------------ preview */

  const clean = useMemo(() => cleanItems(items), [items]);
  const caption = useMemo(() => {
    if (!data) return "";
    return renderSystemMessage(data.captions[locale], {
      "patient.first_name": firstName(patient.full_name),
      "patient.name": patient.full_name,
      "clinic.name": locale === "ar" ? data.clinic.nameAr || data.clinic.name : data.clinic.name,
      "doctor.name": doctor?.name ?? "",
      "prescription.date": fmtDate(new Date(), tz, locale),
      "prescription.medicines": formatMedicineLines(clean),
      "prescription.diagnosis": diagnosis.trim(),
    });
  }, [data, locale, patient.full_name, doctor, tz, clean, diagnosis]);

  /* ------------------------------------------------------------ saving */

  const submit = (send: boolean) => {
    if (!clean.length) {
      toast(T.needMedicine, "error");
      setFocusRow(0);
      return;
    }
    if (!doctorId || pending) return;

    /*
      The print tab is opened here, inside the press, and pointed at the PDF
      once it exists. Opened after the await it would be a popup the browser
      never tied to a click, and blocked.
    */
    let win: Window | null = null;
    if (!send) {
      win = window.open("", "_blank");
      try {
        win?.document.write(
          `<p style="font:16px system-ui,sans-serif;padding:32px;color:#4b5159">${T.preparing}</p>`
        );
      } catch {}
    }

    setPending(send ? "send" : "print");
    createPrescriptionAction(slug, {
      patientId: patient.id,
      doctorMemberId: doctorId,
      locale,
      diagnosis,
      items: clean,
      templateId,
      send,
    })
      .then((r) => {
        if (r.error || !r.row) {
          win?.close();
          toast(T.failed, "error");
          setPending(null);
          return;
        }
        if (!send) {
          if (r.warning === "pdf_failed") win?.close();
          else if (win) win.location.href = `/api/c/${slug}/prescriptions/${r.row.id}/pdf`;
          else toast(T.popupBlocked, "error");
        }
        onSaved(r.row, r.warning, send);
        // The list has just learned something; the next open should know it.
        void reload();
      })
      .catch(() => {
        win?.close();
        toast(T.failed, "error");
        setPending(null);
      });
  };

  const saveTemplate = () => {
    const name = tplName.trim();
    if (!name || !clean.length || tplSaving) return;
    setTplSaving(true);
    saveTemplateAction(slug, { name, diagnosis, items: clean, locale })
      .then((r) => {
        if (!r.template) return toast(t.common.genericError, "error");
        setData((d) => (d ? { ...d, templates: [r.template!, ...d.templates] } : d));
        setTemplateId(r.template.id);
        setTplOpen(false);
        setTplName("");
        toast(T.templateSaved);
      })
      .catch(() => toast(t.common.genericError, "error"))
      .finally(() => setTplSaving(false));
  };

  /* ------------------------------------------------------------ render */

  const hasPhone = !!patient.phone_e164;
  const templates = data?.templates ?? [];
  /*
    The most-used six, with the rest one tap away: a clinic with twenty
    templates would otherwise push the medicines off the first screen of a
    phone. Most-used first, so the six shown are the six that get pressed.
  */
  const TEMPLATE_LIMIT = 6;
  const [allTemplates, setAllTemplates] = useState(false);
  const shownTemplates = allTemplates ? templates : templates.slice(0, TEMPLATE_LIMIT);

  const footer =
    view === "manage" ? (
      <Button variant="outline" size="lg" onClick={() => setView("form")}>
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
        {t.common.back}
      </Button>
    ) : (
      /*
        One row, at every size. On a phone Send takes the width that is left,
        so the primary action is the widest thing under the thumb; from a tablet
        up both sit at the end, where the form's own buttons are elsewhere.
      */
      <div className="flex items-center gap-2 sm:justify-end">
        {/* Under 360px the two labels do not fit side by side at the size
            buttons render (16px), so Print keeps its icon and its accessible
            name and gives its width to Send. */}
        <Button
          variant="outline"
          size="lg"
          onClick={() => submit(false)}
          loading={pending === "print"}
          disabled={!!pending || !doctorId}
          aria-label={T.print}
          className="max-[359px]:px-3.5"
        >
          <Printer className="h-4 w-4" />
          <span className="max-[359px]:sr-only">{T.print}</span>
        </Button>
        <Button
          size="lg"
          className="min-w-0 flex-1 max-[359px]:px-3 sm:flex-none"
          onClick={() => submit(true)}
          loading={pending === "send"}
          disabled={!!pending || !doctorId || !hasPhone}
          title={hasPhone ? undefined : T.noPhone}
        >
          <Send className="h-4 w-4" />
          {T.send}
        </Button>
      </div>
    );

  return (
    <>
      <RxSheet
        title={view === "manage" ? T.manageTitle : T.new}
        sub={patient.full_name}
        closeLabel={t.common.close}
        onClose={requestClose}
        footer={footer}
      >
        {view === "manage" ? (
          <ManageList slug={slug} data={data} setData={setData} />
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-5">
              {!hasPhone && (
                <p className="rounded-lg border border-st-pending/30 bg-st-pending/10 px-3 py-2 text-[13px] text-ink-700">
                  {T.noPhone}
                </p>
              )}

              {/* Doctor and language on one line at every width: both are
                  settled once and rarely touched, so they get one row, not two. */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{T.doctor}</span>
                  <Select
                    value={doctorId ?? ""}
                    onChange={(e) => setDoctorId(e.target.value)}
                    disabled={!data}
                  >
                    {!data && <option value="">{T.loading}</option>}
                    {data?.doctors.map((d) => (
                      <option key={d.member_id} value={d.member_id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <div>
                  <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{T.language}</span>
                  <div role="radiogroup" aria-label={T.language} className="flex h-10 rounded-ctl border border-line p-0.5">
                    {(["ar", "en"] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        role="radio"
                        aria-checked={locale === l}
                        aria-label={l === "ar" ? "عربي" : "English"}
                        onClick={() => switchLocale(l)}
                        className={`min-w-12 rounded-[6px] px-3 text-sm font-semibold transition-colors duration-140 ${
                          locale === l ? "bg-brand-600 text-white" : "text-ink-700 hover:bg-sunken"
                        }`}
                      >
                        {l === "ar" ? (
                          "عربي"
                        ) : (
                          <>
                            <span className="sm:hidden">EN</span>
                            <span className="hidden sm:inline">English</span>
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {doctor && !doctor.has_signature && (
                <p className="-mt-2 text-[12px] leading-5 text-ink-500">
                  {T.noSignature.replace("{doctor}", doctor.name)}{" "}
                  {doctor.is_me && (
                    <Link href={`/c/${slug}/signature`} className="font-semibold text-brand-700 underline">
                      {T.addSignature}
                    </Link>
                  )}
                </p>
              )}

              {/* Templates first: for a routine prescription they are the whole job. */}
              <section>
                {/* Wraps rather than overflows: buttons render at 16px here,
                    and "Save as template" and "Manage list" in English do not
                    fit beside the heading on a 320px phone. */}
                <div className="mb-2 flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <span className="me-auto text-[13px] font-medium text-ink-700">{T.templates}</span>
                  <button
                    type="button"
                    onClick={() => setTplOpen(true)}
                    disabled={!clean.length || tplOpen}
                    className="inline-flex h-8 items-center gap-1 rounded-ctl px-2 text-[12px] font-semibold text-brand-700 hover:bg-brand-50 disabled:text-ink-400 disabled:hover:bg-transparent"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    {T.saveTemplate}
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("manage")}
                    disabled={!data}
                    className="inline-flex h-8 items-center gap-1 rounded-ctl px-2 text-[12px] font-medium text-ink-500 hover:bg-sunken hover:text-ink-900"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    {T.manage}
                  </button>
                </div>

                {tplOpen && (
                  <div className="mb-2 flex items-center gap-2 rounded-card border border-line bg-subtle p-2">
                    <Input
                      autoFocus
                      value={tplName}
                      onChange={(e) => setTplName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveTemplate();
                        if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          setTplOpen(false);
                        }
                      }}
                      placeholder={T.templateNamePlaceholder}
                      aria-label={T.templateName}
                      maxLength={80}
                      className="min-w-0 flex-1"
                    />
                    <Button onClick={saveTemplate} loading={tplSaving} disabled={!tplName.trim()}>
                      {t.common.save}
                    </Button>
                    <Button variant="ghost" onClick={() => setTplOpen(false)}>
                      {t.common.cancel}
                    </Button>
                  </div>
                )}

                {templates.length ? (
                  <>
                    {/* An even grid rather than pills that wrap wherever their
                        names end: every button the same width, lined up, and
                        tall enough for a thumb. A long name takes a second
                        line rather than being cut — the whole point of a
                        template button is being able to read which one it is.
                        Buttons in a row share the taller one's height. */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {shownTemplates.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => applyTemplate(tpl)}
                          title={tpl.name}
                          aria-pressed={templateId === tpl.id}
                          className={`flex min-h-11 min-w-0 items-center justify-center rounded-ctl border px-3 py-1.5 text-[13px] font-semibold leading-snug transition-colors duration-140 ${
                            templateId === tpl.id
                              ? "border-brand-600 bg-brand-600 text-white"
                              : "border-line bg-surface text-ink-900 hover:border-brand-300 hover:bg-brand-50"
                          }`}
                        >
                          <span className="line-clamp-2 break-words text-center">{tpl.name}</span>
                        </button>
                      ))}
                    </div>
                    {templates.length > TEMPLATE_LIMIT && (
                      <button
                        type="button"
                        onClick={() => setAllTemplates((v) => !v)}
                        className="mt-2 text-[12px] font-semibold text-brand-700"
                      >
                        {allTemplates ? T.fewerTemplates : T.allTemplates.replace("{n}", String(templates.length))}
                      </button>
                    )}
                  </>
                ) : (
                  !tplOpen && <p className="text-[12px] leading-5 text-ink-500">{T.noTemplates}</p>
                )}
              </section>

              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{T.diagnosis}</span>
                <Input
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder={T.diagnosisPlaceholder}
                  maxLength={300}
                  dir="auto"
                />
              </label>

              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{T.medicines}</span>
                <div ref={listRef} className="space-y-2.5" onKeyDown={onListKeyDown}>
                  {items.map((it, i) => (
                    <MedicineRow
                      key={i}
                      index={i}
                      item={it}
                      active={active === i}
                      locale={locale}
                      medications={data?.medications ?? []}
                      canRemove={items.length > 1 || !!it.name}
                      onFocus={() => setActive(i)}
                      onChange={(f, v) => setField(i, f, v)}
                      onPick={(m) => pickMedicine(i, m)}
                      onRemove={() => removeRow(i)}
                    />
                  ))}
                </div>
                <Button variant="soft" className="mt-3 w-full sm:w-auto" onClick={addRow} disabled={items.length >= 20}>
                  <Plus className="h-4 w-4" />
                  {T.addMedicine}
                </Button>
              </div>

              {/* On a phone the preview is one tap away rather than beside the form. */}
              <div className="lg:hidden">
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-700"
                >
                  {showPreview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {showPreview ? T.hidePreview : T.showPreview}
                </button>
                {showPreview && (
                  <div className="mt-2">
                    <Preview caption={caption} locale={locale} title={T.preview} fileLabel={dictFor(locale).prescriptions.sheet.title} />
                  </div>
                )}
              </div>
            </div>

            <aside className="hidden lg:block">
              <div className="sticky top-0">
                <Preview caption={caption} locale={locale} title={T.preview} fileLabel={dictFor(locale).prescriptions.sheet.title} />
              </div>
            </aside>
          </div>
        )}
      </RxSheet>

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        title={T.discardTitle}
        body={T.discardBody}
        confirmLabel={T.discard}
        cancelLabel={T.keepEditing}
      />
    </>
  );
}

/* ================================================================ the sheet */

/**
 * The composer's frame: full screen on a phone, a dialog from a tablet up.
 *
 * Its own rather than the shared Modal, because the shared one scrolls as a
 * whole with its header and footer stuck to it — which on a phone left the
 * page showing above a sheet that never reached the top, let the medicine
 * suggestions draw over the title, and put two rows of buttons over a fifth of
 * the screen. Here the header and footer are fixed rows and only the middle
 * scrolls (`data-rx-scroll`, which the suggestions measure against), and the
 * notch and the home bar are kept clear.
 */
function RxSheet({
  title,
  sub,
  closeLabel,
  onClose,
  footer,
  children,
}: {
  title: string;
  sub: string;
  closeLabel: string;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A confirmation open over the sheet takes the Escape for itself.
      if (document.querySelectorAll('[role="dialog"]').length > 1) return;
      close.current();
    };
    document.addEventListener("keydown", onKey);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 hidden bg-[rgb(11_18_32/0.55)] animate-fade-in sm:block"
        onClick={() => close.current()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rx-sheet-title"
        className="relative flex h-dvh w-full flex-col bg-surface animate-fade-up sm:h-auto sm:max-h-[min(92dvh,960px)] sm:max-w-3xl sm:rounded-modal sm:shadow-modal lg:max-w-5xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5 sm:pt-3.5">
          <div className="min-w-0 flex-1">
            <h2 id="rx-sheet-title" className="truncate font-display text-lg font-semibold leading-7 sm:text-xl">
              {title}
            </h2>
            <p className="truncate text-[13px] text-ink-500">{sub}</p>
          </div>
          <button
            type="button"
            onClick={() => close.current()}
            aria-label={closeLabel}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl text-ink-500 hover:bg-sunken"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div data-rx-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {children}
        </div>
        <footer className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-3.5">
          {footer}
        </footer>
      </div>
    </div>,
    document.body
  );
}

/* ================================================================ one medicine */

function MedicineRow({
  index,
  item,
  active,
  locale,
  medications,
  canRemove,
  onFocus,
  onChange,
  onPick,
  onRemove,
}: {
  index: number;
  item: RxItem;
  active: boolean;
  locale: RxLocale;
  medications: ComposerMedication[];
  canRemove: boolean;
  onFocus: () => void;
  onChange: (field: keyof RxItem, value: string) => void;
  onPick: (m: ComposerMedication) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const T = t.prescriptions;
  /*
    The one-tap answers show on the medicine being written and nowhere else.
    Four rows of them under every medicine would bury the form; under the one
    in hand they are exactly where the finger already is.
  */
  const field = (key: "dose" | "frequency" | "duration" | "instructions", label: string, placeholder?: string) => (
    <div className="min-w-0">
      <label className="block">
        <span className="mb-1 block text-[12px] font-medium text-ink-500">{label}</span>
        <Input
          data-rx-input
          value={item[key]}
          onChange={(e) => onChange(key, e.target.value)}
          placeholder={placeholder}
          maxLength={200}
          dir="auto"
          className="h-9"
        />
      </label>
      {active && <Chips chips={RX_CHIPS[key]} locale={locale} value={item[key]} onPick={(v) => onChange(key, v)} />}
    </div>
  );

  return (
    <div
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
      className={`rounded-card border p-3 transition-colors duration-140 ${
        active ? "border-brand-300 bg-surface shadow-sm" : "border-line bg-subtle/40"
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-2 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-100 text-[12px] font-bold text-brand-700 tnum"
        >
          {index + 1}
        </span>
        <MedicineName
          index={index}
          value={item.name}
          medications={medications}
          placeholder={T.medicinePlaceholder}
          label={T.medicineName}
          onChange={(v) => onChange("name", v)}
          onPick={onPick}
        />
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={T.removeMedicine}
            title={T.removeMedicine}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl text-ink-400 hover:bg-sunken hover:text-danger"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {/* Indented under the name from a tablet up, where there is room to show
          what belongs to what; flush on a phone, where 32px is a tenth of the
          screen. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 sm:ps-8">
        {field("dose", T.dose, T.dosePlaceholder)}
        {field("frequency", T.frequency)}
        {field("duration", T.duration)}
        {field("instructions", T.instructions)}
      </div>
    </div>
  );
}

function Chips({
  chips,
  locale,
  value,
  onPick,
}: {
  chips: RxChip[];
  locale: RxLocale;
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" dir={locale === "ar" ? "rtl" : "ltr"}>
      {chips.map((c) => {
        const on = value.trim() === c[locale];
        return (
          <button
            key={c.key}
            type="button"
            // Kept off the focus path: Enter walks the text fields, and a
            // chip in between would swallow the press.
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(on ? "" : c[locale])}
            aria-pressed={on}
            // A finger needs more than a cursor: taller on any touch screen,
            // phone or iPad, and the mouse keeps the compact size.
            className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-[12px] font-medium transition-colors duration-140 pointer-coarse:min-h-9 pointer-coarse:px-3.5 pointer-coarse:text-[13px] ${
              on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-brand-50"
            }`}
          >
            {c[locale]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The medicine name, with the clinic's own list under it.
 *
 * Focused and empty, it offers the most-prescribed — the doctor who writes the
 * same five things all day taps rather than types. Typing narrows it.
 */
function MedicineName({
  index,
  value,
  medications,
  placeholder,
  label,
  onChange,
  onPick,
}: {
  index: number;
  value: string;
  medications: ComposerMedication[];
  placeholder: string;
  label: string;
  onChange: (v: string) => void;
  onPick: (m: ComposerMedication) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  const matches = useMemo(() => {
    const q = norm(value);
    const visible = medications.filter((m) => !m.hidden);
    if (!q) return visible.slice(0, 6);
    // Already exactly one of them: nothing left to suggest.
    if (visible.some((m) => norm(m.name) === q)) return [];
    return visible
      .filter((m) => norm(m.name).includes(q))
      .sort((a, b) => Number(norm(b.name).startsWith(q)) - Number(norm(a.name).startsWith(q)) || b.use_count - a.use_count)
      .slice(0, 7);
  }, [value, medications]);

  const pick = (m: ComposerMedication) => {
    onPick(m);
    setOpen(false);
  };

  /*
    Where the list opens, and how tall it may be.

    Measured against the sheet's scrolling body and the visual viewport — the
    part of the screen the on-screen keyboard has not covered — so the list is
    never drawn under the keyboard, under the footer, or over the title. Below
    the field when there is room, above it when above is roomier.
  */
  const inputRef = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<{ up: boolean; max: number }>({ up: false, max: 288 });
  const measure = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const box = el.closest("[data-rx-scroll]")?.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = Math.max(box?.top ?? 0, vv?.offsetTop ?? 0);
    const bottom = Math.min(box?.bottom ?? window.innerHeight, vv ? vv.offsetTop + vv.height : window.innerHeight);
    const below = bottom - r.bottom - 8;
    const above = r.top - top - 8;
    const up = below < 180 && above > below;
    setPlace({ up, max: Math.max(96, Math.min(288, up ? above : below)) });
  }, []);

  /*
    On a touch screen, bring the field up to the top of the sheet once the
    keyboard has opened, so the suggestions have the rest of the screen to
    open into. A mouse user already sees the whole form and is left alone.
  */
  const onFocus = () => {
    setOpen(true);
    measure();
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;
    setTimeout(() => {
      const el = inputRef.current;
      const scroller = el?.closest<HTMLElement>("[data-rx-scroll]");
      if (!el || !scroller || document.activeElement !== el) return;
      const gap = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
      if (gap > 40) scroller.scrollBy({ top: gap, behavior: "smooth" });
      setTimeout(measure, 350);
    }, 320);
  };

  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    vv?.addEventListener("resize", measure);
    return () => vv?.removeEventListener("resize", measure);
  }, [open, measure]);

  const listId = `rx-med-${index}`;
  const shown = open && matches.length > 0;

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        ref={inputRef}
        data-rx-input
        data-rx-name={index}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(0);
          measure();
        }}
        onFocus={onFocus}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!shown) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && matches[hi] && value.trim()) {
            // Only once something is typed: Enter on an empty name moves on,
            // it does not quietly prescribe the clinic's most common drug.
            e.preventDefault();
            e.stopPropagation();
            pick(matches[hi]);
          } else if (e.key === "Escape") {
            // Closes the list, not the prescription.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        maxLength={200}
        dir="auto"
        className="font-semibold"
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          style={{ maxHeight: place.max }}
          className={`absolute inset-x-0 z-20 overflow-auto overscroll-contain rounded-card border border-line bg-surface p-1 shadow-pop ${
            place.up ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {matches.map((m, k) => {
            const detail = itemDetail(m);
            return (
              <li
                key={m.id}
                role="option"
                aria-selected={k === hi}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                onMouseEnter={() => setHi(k)}
                className={`cursor-pointer rounded-lg px-3 py-2 pointer-coarse:py-2.5 ${k === hi ? "bg-brand-50" : ""}`}
              >
                <div className="text-sm font-semibold" dir="auto">
                  {m.name}
                </div>
                {detail && (
                  <div className="truncate text-[12px] text-ink-500" dir="auto">
                    {detail}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ================================================================ the preview */

/** What lands on the patient's phone: the PDF, with the medicines written under it. */
function Preview({
  caption,
  locale,
  title,
  fileLabel,
}: {
  caption: string;
  locale: RxLocale;
  title: string;
  fileLabel: string;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{title}</span>
      <div className="rounded-card bg-[#e9e4dc] p-3">
        <div
          dir={locale === "ar" ? "rtl" : "ltr"}
          className="ms-auto max-w-[95%] rounded-2xl rounded-be-md bg-[#d9fdd3] p-2 text-[13px] text-[#111b21] shadow-sm"
        >
          <div className="flex items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2">
            <FileText className="h-5 w-5 shrink-0 text-[#d9534f]" />
            <span className="truncate font-medium">{fileLabel}.pdf</span>
          </div>
          {/* Line by line, each finding its own direction, because that is
              how WhatsApp draws it: "1. Amoxicillin" reads left to right
              inside an Arabic message, where one direction for the whole
              caption would show it as "Amoxicillin .1". */}
          {caption && (
            <div className="mt-1.5 whitespace-pre-wrap break-words px-1 leading-5">
              {caption.split("\n").map((line, i) => (
                <div key={i} dir="auto">
                  {line || " "}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================================================================ manage */

function ManageList({
  slug,
  data,
  setData,
}: {
  slug: string;
  data: ComposerData | null;
  setData: (fn: (d: ComposerData | null) => ComposerData | null) => void;
}) {
  const { t } = useI18n();
  const T = t.prescriptions;
  const { toast } = useToast();
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);
  const [busy, setBusy] = useState(false);

  if (!data) return <p className="text-sm text-ink-500">{T.loading}</p>;

  // Moves on the press; the server confirms behind it, and a refusal puts it back.
  const toggleHidden = (m: ComposerMedication) => {
    const next = !m.hidden;
    const flip = (hidden: boolean) =>
      setData((d) =>
        d ? { ...d, medications: d.medications.map((x) => (x.id === m.id ? { ...x, hidden } : x)) } : d
      );
    flip(next);
    setMedicationHiddenAction(slug, m.id, next)
      .then((r) => {
        if (r.error) {
          flip(!next);
          toast(t.common.genericError, "error");
        }
      })
      .catch(() => {
        flip(!next);
        toast(t.common.genericError, "error");
      });
  };

  const removeTemplate = () => {
    if (!deleting) return;
    setBusy(true);
    deleteTemplateAction(slug, deleting.id)
      .then((r) => {
        if (r.error) return toast(t.common.genericError, "error");
        const id = deleting.id;
        setData((d) => (d ? { ...d, templates: d.templates.filter((x) => x.id !== id) } : d));
        setDeleting(null);
      })
      .catch(() => toast(t.common.genericError, "error"))
      .finally(() => setBusy(false));
  };

  /*
    grid-cols-1, not the implicit column: an implicit track is as wide as the
    longest unbroken name in it, and "Chlorhexidine mouthwash 0.12%" pushed the
    hide buttons off the side of a phone.
  */
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="min-w-0">
        <h3 className="text-[15px] font-semibold">{T.manageTemplates}</h3>
        {data.templates.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-500">{T.noTemplatesYet}</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-card border border-line">
            {data.templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{tpl.name}</div>
                  <div className="truncate text-[12px] text-ink-500" dir="auto">
                    {tpl.items.map((i) => i.name).join(" · ")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDeleting(tpl)}
                  aria-label={T.deleteTemplate}
                  title={T.deleteTemplate}
                  className="rounded-md p-1.5 text-ink-400 hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="min-w-0">
        <h3 className="text-[15px] font-semibold">{T.manageMedicines}</h3>
        <p className="mt-0.5 text-[12px] text-ink-500">{T.manageMedicinesHint}</p>
        {data.medications.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-500">{T.noMedicines}</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-card border border-line lg:max-h-[50dvh] lg:overflow-auto">
            {data.medications.map((m) => (
              <li key={m.id} className={`flex items-center gap-3 px-3 py-2.5 ${m.hidden ? "opacity-55" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold" dir="auto">
                    {m.name}
                  </div>
                  <div className="truncate text-[12px] text-ink-500" dir="auto">
                    {m.hidden ? T.hidden : [itemDetail(m), T.uses.replace("{n}", String(m.use_count))].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => toggleHidden(m)}>
                  {m.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  {m.hidden ? T.show : T.hide}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={removeTemplate}
        loading={busy}
        title={T.deleteTemplate}
        body={deleting ? T.deleteTemplateConfirm.replace("{name}", deleting.name) : ""}
        confirmLabel={T.deleteTemplate}
        cancelLabel={t.common.cancel}
      />
    </div>
  );
}
