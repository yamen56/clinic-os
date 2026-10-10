"use client";

/*
  Who did what, and when.

  Every entry carries the doctor who performed it and the person who recorded
  it — at a dental chair those are often two people, the dentist working and
  the assistant typing. Every change to an entry is its own line, so the
  history of a tooth reads like the clinical notes it replaces: planned on this
  visit, done on that one, voided here and why.
*/

import { useState } from "react";
import { Check, ChevronDown, Ban, Plus, Pencil, UserRound, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { findTreatment, type Treatment } from "@/lib/charts/dental/catalog";
import { isToothSite, paintAt, type Mark, type MarkEvent, type Paint, type Person } from "@/lib/charts/dental/state";
import { tooth as toothOf } from "@/lib/charts/dental/teeth";
import { TreatmentGlyph } from "./treatment-picker";
import { detailLabels, markLabel, siteLabel } from "./labels";
import { INK, SOFT } from "./tooth-art";

export function PaintPill({ m }: { m: Mark }) {
  const { t } = useI18n();
  const paint = m.voidedAt ? null : paintAt(m, null);
  if (!paint) {
    return <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{t.dental.voided}</span>;
  }
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: SOFT[paint], color: INK[paint] }}>
      {t.dental.status[paint]}
    </span>
  );
}

function fallbackTreatment(m: Mark): Treatment {
  return { key: m.treatmentKey, kind: m.kind, category: "findings", en: m.label, ar: m.labelAr, scope: "tooth", look: m.look };
}

/** One entry on a tooth: what, how far along, who — and, opened, what can be changed. */
export function EntryRow({
  m,
  custom,
  doctors,
  tz,
  canEdit,
  onMarkDone,
  onVoid,
  onNote,
  onDetail,
  onPerformer,
  extra,
}: {
  m: Mark;
  custom: Treatment[];
  doctors: Person[];
  tz: string;
  canEdit: boolean;
  /** A line of its own about the entry — where a full arch's implants are. */
  extra?: string;
  onMarkDone: (id: string) => void;
  onVoid: (m: Mark) => void;
  onNote: (id: string, note: string) => void;
  onDetail: (id: string, key: string, value: string) => void;
  onPerformer: (id: string, personId: string) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const [open, setOpen] = useState(false);
  const tr = findTreatment(m.treatmentKey, custom) ?? fallbackTreatment(m);
  const paint = paintAt(m, null) ?? "existing";
  const details = detailLabels(m, custom, locale);
  const ctx = isToothSite(m.site) ? toothOf(m.site) : null;
  const editable = canEdit && !m.voidedAt;

  return (
    <li className={`rounded-ctl border border-line bg-surface ${m.voidedAt ? "opacity-60" : ""}`} data-mark={m.id}>
      <div className="flex items-start gap-2.5 p-2.5">
        <TreatmentGlyph tr={tr} paint={paint} context={ctx} size={42} />
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-start">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`text-[13.5px] font-semibold text-ink-900 ${m.voidedAt ? "line-through" : ""}`}>{markLabel(m, locale)}</span>
            <PaintPill m={m} />
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-ink-500">
            {[extra ?? details.join(" · "), m.performedBy?.name, fmtDate(m.doneAt ?? m.createdAt, tz, locale)].filter(Boolean).join(" · ")}
          </span>
          {m.note && <span className="mt-1 block text-[12.5px] text-ink-700">{m.note}</span>}
        </button>
        {editable && m.status === "planned" && (
          <button
            type="button"
            onClick={() => onMarkDone(m.id)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-ctl px-2.5 text-[12.5px] font-semibold"
            style={{ background: SOFT.done, color: INK.done }}
          >
            <Check className="h-3.5 w-3.5" />
            <span className="max-[420px]:sr-only">{T.markDone}</span>
          </button>
        )}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-label={T.history} className="grid h-8 w-8 shrink-0 place-items-center rounded-ctl text-ink-400 hover:bg-sunken">
          <ChevronDown className={`h-4 w-4 transition-transform duration-140 ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div className="grid gap-3 border-t border-line px-3 py-3">
          {tr.details?.filter((d) => !(d.key === "implants" && m.groupId)).map((d) => (
            <div key={d.key}>
              <div className="mb-1.5 text-[12px] font-semibold text-ink-500">{T.details[d.key]}</div>
              <div className="flex flex-wrap gap-1.5">
                {d.options.map((o) => {
                  const on = m.detail[d.key] === o.key;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      disabled={!editable}
                      onClick={() => onDetail(m.id, d.key, o.key)}
                      className={`h-8 rounded-full border px-3 text-[12.5px] font-semibold transition-colors duration-140 disabled:opacity-60 ${
                        on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                      }`}
                    >
                      {locale === "ar" ? o.ar : o.en}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-500">{T.performedBy}</span>
            <select
              disabled={!editable}
              value={m.performedBy?.id ?? ""}
              onChange={(e) => onPerformer(m.id, e.target.value)}
              className="select-chevron h-9 w-full appearance-none rounded-ctl border border-line bg-surface ps-3 pe-8 text-base disabled:bg-subtle md:text-sm"
            >
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink-500">{T.note}</span>
            <textarea
              disabled={!editable}
              defaultValue={m.note}
              placeholder={T.notePlaceholder}
              rows={2}
              onBlur={(e) => e.target.value !== m.note && onNote(m.id, e.target.value)}
              className="w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base disabled:bg-subtle md:text-sm"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-500">
            <span>
              {T.recordedBy.replace("{name}", m.recordedBy.name)} · {fmtDateTime(m.createdAt, tz, locale)}
            </span>
            {editable && (
              <button type="button" onClick={() => onVoid(m)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-danger hover:bg-danger-soft">
                <Ban className="h-3.5 w-3.5" />
                {T.void}
              </button>
            )}
          </div>
          {m.voidedAt && (
            <p className="text-[12px] text-ink-500">
              {T.voided} · {m.voidedBy?.name} · {fmtDateTime(m.voidedAt, tz, locale)}
              {m.voidReason ? ` — ${m.voidReason}` : ""}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

const EVENT_ICON: Record<MarkEvent["action"], LucideIcon> = {
  created: Plus,
  done: Check,
  void: Ban,
  note: Pencil,
  performer: UserRound,
};

/** The ink of one line in the history: what the entry was at that moment. */
function eventPaint(e: MarkEvent, m: Mark): Paint | null {
  if (e.action === "void") return null;
  if (m.kind === "finding") return "finding";
  if (e.action === "done") return "done";
  if (e.action === "created") return m.status === "existing" ? "existing" : m.doneAt === m.createdAt ? "done" : "planned";
  return paintAt(m, null);
}

/** Every change, newest first. Used for one tooth in the panel and for the mouth below the chart. */
export function EventList({ events, marks, tz, showSite }: { events: MarkEvent[]; marks: Mark[]; tz: string; showSite?: boolean }) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const byId = new Map(marks.map((m) => [m.id, m]));
  const rows = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (rows.length === 0) return <p className="py-3 text-[13px] text-ink-500">{T.noHistory}</p>;
  return (
    <ol className="relative ms-2.5 grid gap-0.5 border-s border-line ps-6">
      {rows.map((e) => {
        const m = byId.get(e.markId);
        if (!m) return null;
        const paint = eventPaint(e, m);
        // What happened, as a picture: recorded, done, voided, re-noted, re-assigned.
        const Icon = EVENT_ICON[e.action];
        return (
          <li key={e.id} className="relative py-1.5" data-event={e.action}>
            <span
              className="absolute -start-[34px] top-1.5 grid h-5 w-5 place-items-center rounded-md ring-2 ring-surface"
              style={{ background: paint ? SOFT[paint] : "var(--color-sunken)", color: paint ? INK[paint] : "var(--color-ink-500)" }}
            >
              <Icon className="h-3 w-3" strokeWidth={2.6} />
            </span>
            <div className="text-[13px] leading-snug text-ink-900">
              {showSite && <span className="font-semibold">{siteLabel(m.site, T)} · </span>}
              <span className={e.action === "void" ? "line-through" : ""}>{markLabel(m, locale)}</span>
              <span className="text-ink-500"> — {T.events[e.action]}</span>
            </div>
            <div className="text-[12px] text-ink-500">
              {[
                e.action === "created" || e.action === "done" ? m.performedBy?.name : null,
                fmtDateTime(e.at, tz, locale),
                e.by.id !== m.performedBy?.id || e.action === "void" ? T.recordedBy.replace("{name}", e.by.name) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {e.reason ? ` — ${e.reason}` : ""}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
