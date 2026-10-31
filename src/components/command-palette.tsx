"use client";

/*
  Find anything from anywhere: one box at the top of every screen.

  The question the desk and the doctor ask a hundred times a day is "where is
  this patient" — and the answer used to be: go to Patients, then search. Here
  a name, a phone or a file number from any screen opens the file, with the
  next visit beside it so "when is she coming" needs no click at all. The same
  box starts the day's four jobs and opens any section by name.

  On a phone it is the whole screen, under the thumb and above the keyboard; a
  doctor between rooms does not type a shortcut. On a keyboard it is Ctrl/⌘K
  or "/", from anywhere that is not already a text field.
*/

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowRight, CalendarPlus, CornerDownLeft, MessagesSquare, ReceiptText, Search, UserPlus, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Avatar } from "@/components/ui/misc";
import { formatPhone } from "@/lib/phone";
import { fmtDateTime } from "@/lib/dates";

type Found = { id: string; full_name: string; phone_e164: string | null; file_no: number | null; next_at: string | null };

export type PaletteAction = { key: string; label: string; href: string; icon: "appointment" | "patient" | "invoice" | "inbox" };
export type PalettePage = { key: string; label: string; href: string };

const ACTION_ICONS = { appointment: CalendarPlus, patient: UserPlus, invoice: ReceiptText, inbox: MessagesSquare };

type Item =
  | { kind: "patient"; id: string; href: string; p: Found }
  | { kind: "action"; id: string; href: string; a: PaletteAction }
  | { kind: "page"; id: string; href: string; g: PalettePage };

export function CommandPalette({
  slug,
  tz,
  open,
  onClose,
  canSearch,
  patientHref,
  actions,
  pages,
}: {
  slug: string;
  tz: string;
  open: boolean;
  onClose: () => void;
  /** May look a patient up at all — the same gate as the search route. */
  canSearch: boolean;
  /** Where a found patient goes for this member: their file, or a booking for them. */
  patientHref: ((id: string) => string) | null;
  actions: PaletteAction[];
  pages: PalettePage[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // Fresh each time it opens: last search's patient is rarely this one's.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setFound([]);
    setHi(0);
    const h = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(h);
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!open || !canSearch || !patientHref || term.length < 2) {
      setFound([]);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(term)}`);
        const j = res.ok ? ((await res.json()) as { results?: Found[] }) : null;
        if (mine === seq.current) setFound(j?.results ?? []);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(h);
  }, [q, open, canSearch, patientHref, slug]);

  const items: Item[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const match = (label: string) => !term || label.toLowerCase().includes(term);
    return [
      ...(patientHref ? found.map((p) => ({ kind: "patient" as const, id: `p:${p.id}`, href: patientHref(p.id), p })) : []),
      ...actions.filter((a) => match(a.label)).map((a) => ({ kind: "action" as const, id: `a:${a.key}`, href: a.href, a })),
      ...(term ? pages.filter((g) => match(g.label)).map((g) => ({ kind: "page" as const, id: `g:${g.key}`, href: g.href, g })) : []),
    ];
  }, [found, actions, pages, q, patientHref]);

  useEffect(() => setHi(0), [items.length, q]);

  // The highlighted row stays in view as the arrows move it.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  if (!open) return null;

  const go = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    router.push(it.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[hi]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const term = q.trim();
  const patients = items.filter((i) => i.kind === "patient");
  const rest = items.filter((i) => i.kind !== "patient");
  const row = (it: Item, index: number) => {
    const active = index === hi;
    const cls = `flex w-full min-h-12 touch-manipulation items-center gap-3 rounded-lg px-3 py-2 text-start transition-colors duration-100 ${
      active ? "bg-brand-50 text-ink-900" : "text-ink-700 hover:bg-sunken"
    }`;
    if (it.kind === "patient") {
      const p = it.p;
      return (
        <button key={it.id} type="button" className={cls} data-palette-index={index} data-palette-patient={p.id} onMouseMove={() => setHi(index)} onClick={() => go(it)}>
          <Avatar name={p.full_name} size={30} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold text-ink-900">{p.full_name}</span>
            <span className="flex flex-wrap gap-x-2 text-[12px] text-ink-500">
              {p.phone_e164 && (
                <span dir="ltr" className="tnum">
                  {formatPhone(p.phone_e164)}
                </span>
              )}
              {p.file_no != null && <span className="tnum">{t.devices.fileNo.replace("{n}", String(p.file_no))}</span>}
            </span>
          </span>
          {p.next_at && (
            <span className="shrink-0 text-end text-[11.5px] leading-tight text-ink-500">
              <span className="block">{t.search.next}</span>
              <span className="block font-semibold text-ink-700 tnum">{fmtDateTime(p.next_at, tz, locale)}</span>
            </span>
          )}
        </button>
      );
    }
    const Icon = it.kind === "action" ? ACTION_ICONS[it.a.icon] : ArrowRight;
    return (
      <button key={it.id} type="button" className={cls} data-palette-index={index} data-palette-item={it.id} onMouseMove={() => setHi(index)} onClick={() => go(it)}>
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-sunken text-ink-500">
          <Icon className={`h-4 w-4 ${it.kind === "page" ? "rtl:rotate-180" : ""}`} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{it.kind === "action" ? it.a.label : it.g.label}</span>
        {active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-400 max-md:hidden" />}
      </button>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={t.search.title} data-command-palette>
      <button type="button" aria-label={t.common.close} onClick={onClose} className="absolute inset-0 bg-night/30 animate-fade-in max-md:hidden" />
      <div className="relative mx-auto flex h-full w-full flex-col bg-surface animate-fade-in md:mt-[12vh] md:h-auto md:max-h-[70vh] md:max-w-xl md:rounded-xl md:border md:border-line md:shadow-pop">
        <div className="flex items-center gap-2 border-b border-line px-3 pt-[env(safe-area-inset-top)] md:pt-0">
          <Search className="h-5 w-5 shrink-0 text-ink-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            dir="auto"
            enterKeyHint="go"
            autoComplete="off"
            placeholder={canSearch ? t.search.placeholder : t.search.placeholderNoPatients}
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
            data-palette-input
          />
          <button type="button" onClick={onClose} aria-label={t.common.close} className="grid h-10 w-10 shrink-0 touch-manipulation place-items-center rounded-full text-ink-500 hover:bg-sunken md:hidden">
            <X className="h-5 w-5" />
          </button>
          <kbd className="rounded border border-line px-1.5 text-[11px] font-semibold text-ink-400 max-md:hidden">Esc</kbd>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {patients.length > 0 && (
            <>
              <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t.search.patients}</div>
              {patients.map((it) => row(it, items.indexOf(it)))}
            </>
          )}
          {canSearch && patientHref && term.length >= 2 && !loading && patients.length === 0 && (
            <p className="px-3 py-3 text-[13px] text-ink-500" data-palette-empty>
              {t.search.noPatients.replace("{q}", term)}
            </p>
          )}
          {rest.length > 0 && (
            <>
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{term ? t.search.actionsAndPages : t.search.actions}</div>
              {rest.map((it) => row(it, items.indexOf(it)))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Whether a key press belongs to somebody typing, a dialog, or nobody — only the last may open things. */
export function keyIsFree(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return false;
  return !document.querySelector('[role="dialog"]');
}
