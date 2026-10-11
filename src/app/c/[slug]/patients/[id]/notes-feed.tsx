"use client";

/*
  The Notes tab's notes from elsewhere in the file.

  Yamen asked for every note about a patient to be connected: whatever was
  written on a visit, an invoice, the dental chart or anywhere else in the
  file shows in the patient's notes, saying where it came from. Each stays
  where it was written — that is where it is edited — and here it is read,
  in order with the notes written here, with a way back to it.

  Two kinds. The server's (lib/note-feed.ts): a visit's notes and booking
  answers, an invoice's note and its claim's, a prescription's diagnosis, a
  waitlist note, an x-ray request's. And the chart's, from the chart the file
  already holds, so a note written on a tooth a moment ago is here when the
  tab is opened: an entry's note, a step's, an emergency, a case's history
  and diagnosis. Kept on the file and not dated — the Overview's summary and
  the medical history — sit above them all.
*/

import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  CalendarDays,
  ClipboardList,
  FileText,
  HeartPulse,
  Hourglass,
  ListChecks,
  Pill,
  ReceiptText,
  ShieldCheck,
  Siren,
  Smile,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { fmtDate, fmtTime } from "@/lib/dates";
import type { FeedItem, FeedSource } from "@/lib/note-feed";
import { useOptionalDentalStore } from "@/components/charts/dental/store";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { EMERGENCY_STEP, stepOf } from "@/lib/charts/dental/protocols";
import { hasHistory, medicalAlerts } from "@/lib/medical-history";

export type OtherSource = FeedSource | "chart" | "step" | "emergency" | "case";

/** A note from elsewhere in the file, ready to show. */
export type Other = {
  key: string;
  source: OtherSource;
  at: string;
  by: string | null;
  /** What it is on: "INV-2026-0012", "36 · Root canal treatment · Working length". */
  title: string;
  body: string;
  lines: string[];
  open?: () => void;
};

export const SOURCE_ICON: Record<OtherSource, LucideIcon> = {
  visit: CalendarDays,
  invoice: ReceiptText,
  claim: ShieldCheck,
  prescription: Pill,
  waitlist: Hourglass,
  xray: FileText,
  chart: Smile,
  step: ListChecks,
  emergency: Siren,
  case: ClipboardList,
};

type Answer = { label?: string; labelAr?: string; value?: unknown };
type RxLine = { name?: string; dose?: string; frequency?: string; duration?: string; instructions?: string };

/** Every note from elsewhere in the file, newest first. */
export function useOtherNotes({
  slug,
  feed,
  tabKeys,
  onTab,
}: {
  slug: string;
  feed: FeedItem[];
  tabKeys: string[];
  onTab: (key: string) => void;
}): Other[] {
  const { t, locale } = useI18n();
  const N = t.patients.notes;
  const router = useRouter();
  const store = useOptionalDentalStore();
  const has = (k: string) => tabKeys.includes(k);
  const out: Other[] = [];

  for (const f of feed) {
    const svc = (locale === "ar" ? f.serviceAr : null) || f.service;
    if (f.source === "visit") {
      const answers = Array.isArray(f.extra) ? (f.extra as Answer[]) : [];
      out.push({
        key: `visit:${f.id}`,
        source: "visit",
        at: f.at,
        by: f.by,
        // The service; the card puts the visit's time in the clinic's day before it.
        title: svc ?? "",
        body: f.body,
        lines: answers
          .filter((a) => a.value !== undefined && a.value !== null && String(a.value).trim() !== "")
          .map((a) => `${(locale === "ar" ? a.labelAr : null) || a.label || ""}: ${Array.isArray(a.value) ? a.value.join("، ") : String(a.value)}`),
        open: () => router.push(`/c/${slug}/calendar?open=${f.id}`),
      });
    } else if (f.source === "invoice" || f.source === "claim") {
      out.push({
        key: `${f.source}:${f.id}`,
        source: f.source,
        at: f.at,
        by: f.by,
        title: f.ref ?? "",
        body: f.body,
        lines: [],
        open: () => router.push(`/c/${slug}/invoices/${f.id}`),
      });
    } else if (f.source === "prescription") {
      const items = Array.isArray(f.extra) ? (f.extra as RxLine[]) : [];
      out.push({
        key: `rx:${f.id}`,
        source: "prescription",
        at: f.at,
        by: f.by,
        title: f.ref ? `#${f.ref}` : "",
        body: f.body ? `${N.caseFields.diagnosis}: ${f.body}` : "",
        lines: items
          .filter((x) => x.name)
          .map((x) => [[x.name, x.dose, x.frequency, x.duration].filter(Boolean).join(" "), x.instructions].filter(Boolean).join(" — ")),
        open: has("prescriptions") ? () => onTab("prescriptions") : undefined,
      });
    } else if (f.source === "waitlist") {
      out.push({
        key: `wl:${f.id}`,
        source: "waitlist",
        at: f.at,
        by: f.by,
        title: svc ?? "",
        body: f.body,
        lines: [],
        open: () => router.push(`/c/${slug}/waitlist`),
      });
    } else if (f.source === "xray") {
      const teeth = Array.isArray(f.extra) ? (f.extra as string[]) : [];
      out.push({
        key: `xray:${f.id}`,
        source: "xray",
        at: f.at,
        by: f.by,
        title: teeth.length ? teeth.join(" · ") : "",
        body: f.body,
        lines: [],
        open: has("files") ? () => onTab("files") : undefined,
      });
    }
  }

  // The chart's notes: live, from the chart the file holds.
  if (store) {
    const markName = (m: Mark) => `${isToothSite(m.site) ? `${m.site} · ` : ""}${locale === "ar" ? m.labelAr || m.label : m.label}`;
    const openItem = (markId: string) => () => {
      onTab("treatment");
      store.setOpenItem(markId);
    };
    const byId = new Map(store.marks.map((m) => [m.id, m]));
    for (const m of store.marks) {
      if (m.voidedAt || !m.note.trim()) continue;
      // When the note was written, and by whom: its last "note" event, else the entry itself.
      const ev = store.events.filter((e) => e.markId === m.id && e.action === "note").sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      out.push({
        key: `mark:${m.id}`,
        source: "chart",
        at: ev?.at ?? m.createdAt,
        by: ev?.by.name ?? m.recordedBy.name,
        title: markName(m),
        body: m.note,
        lines: [],
        open: has("treatment") ? openItem(m.id) : undefined,
      });
    }
    for (const s of store.steps) {
      if (s.voidedAt) continue;
      const m = byId.get(s.markId);
      if (!m) continue;
      if (s.step === EMERGENCY_STEP) {
        const data = s.data as { complaint?: string; done?: string[] };
        const done = (data.done ?? []).map((k) => (t.dental.treatment.emergencyActions as Record<string, string>)[k] ?? k);
        const body = [data.complaint, s.note].filter((x) => x && String(x).trim()).join("\n");
        if (!body && !done.length) continue;
        out.push({
          key: `step:${s.id}`,
          source: "emergency",
          at: s.doneAt,
          by: s.performedBy?.name ?? s.recordedBy.name,
          title: markName(m),
          body,
          lines: done.length ? [done.join(" · ")] : [],
          open: has("treatment") ? openItem(m.id) : undefined,
        });
        continue;
      }
      if (!s.note.trim()) continue;
      const def = stepOf(m.treatmentKey, s.step);
      out.push({
        key: `step:${s.id}`,
        source: "step",
        at: s.doneAt,
        by: s.performedBy?.name ?? s.recordedBy.name,
        title: `${markName(m)}${def ? ` · ${def.en}` : ""}`,
        body: s.note,
        lines: [],
        open: has("treatment") ? openItem(m.id) : undefined,
      });
    }
    for (const c of store.cases) {
      const lines = (
        [
          ["complaint", c.complaint],
          ["history", c.history],
          ["exam", c.exam],
          ["diagnosis", c.diagnosis],
        ] as const
      )
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${N.caseFields[k]}: ${v.trim()}`);
      if (!lines.length) continue;
      out.push({
        key: `case:${c.id}`,
        source: "case",
        at: c.createdAt,
        by: c.doctor?.name ?? c.createdBy.name,
        title: c.title || c.complaint,
        body: "",
        lines,
        open: has("treatment")
          ? () => {
              onTab("treatment");
              store.setActiveCaseId(c.id);
            }
          : undefined,
      });
    }
  }
  return out;
}

/** One note from elsewhere: where it came from, what it is on, who wrote it and when — and the way back. */
export function OtherNoteCard({ o, tz }: { o: Other; tz: string }) {
  const { t, locale } = useI18n();
  const N = t.patients.notes;
  const Icon = SOURCE_ICON[o.source];
  // A visit is named by its time in the clinic's day, as everywhere else.
  const title = o.source === "visit" ? [`${fmtDate(o.at, tz, locale)} · ${fmtTime(o.at, tz, locale)}`, o.title].filter(Boolean).join(" · ") : o.title;
  return (
    <div data-feed-source={o.source} data-feed-key={o.key}>
      <Card className="p-4">
        <div className="mb-1.5 flex items-start justify-between gap-2 text-[12px] text-ink-400">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-brand-50 px-2 text-[11px] font-semibold text-brand-700">
              <Icon className="h-3 w-3" />
              {N.sources[o.source]}
            </span>
            {title && (
              <span className="font-medium text-ink-700" dir="auto">
                {title}
              </span>
            )}
            <span>{[o.by, o.source === "visit" ? null : `${fmtDate(o.at, tz, locale)} · ${fmtTime(o.at, tz, locale)}`].filter(Boolean).join(" · ")}</span>
          </span>
          {o.open && (
            <button
              type="button"
              onClick={o.open}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
              data-feed-open={o.key}
            >
              {N.openSource}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {o.body && (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-900" dir="auto">
            {o.body}
          </p>
        )}
        {o.lines.length > 0 && (
          <ul className={`grid gap-0.5 text-[12.5px] text-ink-700 ${o.body ? "mt-1.5" : ""}`}>
            {o.lines.map((l, i) => (
              <li key={i} dir="auto">
                {l}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** What is kept on the file rather than written on a day: the Overview's summary, the medical history. */
export function OnFile({ summary, onSummary, onMedical }: { summary: string; onSummary: () => void; onMedical?: () => void }) {
  const { t, locale } = useI18n();
  const N = t.patients.notes;
  const store = useOptionalDentalStore();
  const medical = store?.medical ?? null;
  const showMedical = !!medical && hasHistory(medical);
  if (!summary.trim() && !showMedical) return null;
  return (
    <div className="grid gap-2" data-on-file>
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-400">{N.onFile}</h3>
      {summary.trim() && (
        <div data-on-file-summary>
          <Card className="p-4">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-ink-400">
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-sunken px-2 text-[11px] font-semibold text-ink-700">{N.sources.summary}</span>
              <button type="button" onClick={onSummary} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-500 hover:bg-ink-900/5 hover:text-ink-900">
                {N.openSource}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-900" dir="auto">
              {summary}
            </p>
          </Card>
        </div>
      )}
      {showMedical && medical && (
        <div data-on-file-medical>
          <Card className="p-4">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-ink-400">
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-danger-soft px-2 text-[11px] font-semibold text-danger">
                <HeartPulse className="h-3 w-3" />
                {N.sources.medical}
              </span>
              {onMedical && (
                <button type="button" onClick={onMedical} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-500 hover:bg-ink-900/5 hover:text-ink-900">
                  {N.openSource}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {medicalAlerts(medical, locale).map((a) => (
                <span key={a} className="rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-semibold text-danger">
                  {a}
                </span>
              ))}
            </div>
            {medical.medications.trim() && (
              <p className="mt-1.5 text-[13px] text-ink-900" dir="auto">
                <span className="text-ink-500">{N.medications}: </span>
                {medical.medications}
              </p>
            )}
            {medical.notes.trim() && (
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-900" dir="auto">
                {medical.notes}
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
