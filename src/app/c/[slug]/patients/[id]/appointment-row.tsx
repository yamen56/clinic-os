"use client";

/*
  One appointment in the patient's Appointments tab — and, opened, everything
  it holds.

  Yamen, 2026-11-15: "make the appointments in the patient profile appear all
  of the details that are in this appointment". It used to open on the visit's
  notes and dental work only; the rest — who booked it, when they arrived and
  how long they waited, the room, the hand-off, the invoice — was in the
  calendar's panel, one screen away. Now the row says all of it, in the order
  a visit happens: what was booked, how the day went, what was found and done
  (the visit's record, its prescription and files), how it was left, what it
  cost. "Open in the calendar" is still there for changing it.

  The Treatment card's visits lead here (`focused`), and this row leads back
  to the record (Record visit / Edit), so a visit is one thing wherever it is
  opened.
*/

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DateTime } from "luxon";
import { CalendarDays, ChevronRight, ClipboardPen, ExternalLink, ReceiptText, StickyNote } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Tooth } from "@/components/ui/tooth-icon";
import { VoiceNote } from "@/components/voice-note";
import { fmtDateTime, fmtMoney, fmtTime } from "@/lib/dates";
import { nextWhen } from "@/lib/next-visit";
import { minutesBetween } from "@/lib/patient-flow";
import { VisitWork, useVisitWorkCount } from "@/components/charts/dental/visit-work";
import { useOptionalTreatmentStore } from "@/components/treatment/store";
import { VisitRecordView, useChartWork } from "@/components/treatment/visit-record-view";
import { hasText, standing } from "@/lib/treatment/visits";
import type { NoteCategoryRow, NoteRow } from "./profile-client";

const apptStatus: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

/** An appointment as the patient file loads it: the row, and everything its details show. */
export type RowAppointment = {
  id: string;
  starts_at: string;
  status: string;
  service_name: string | null;
  service_name_ar: string | null;
  doctor_name: string | null;
  ends_at?: string | null;
  source?: string | null;
  walk_in?: boolean | null;
  created_at?: string | null;
  created_by_name?: string | null;
  booking_link_name?: string | null;
  room_name?: string | null;
  room_name_ar?: string | null;
  arrived_at?: string | null;
  seated_at?: string | null;
  finished_at?: string | null;
  late_min?: number | null;
  notes?: string | null;
  intake_answers?: unknown;
  next_visit_days?: number | null;
  next_visit_none?: boolean | null;
  desk_note?: string | null;
  handed_off_at?: string | null;
  /** Cancelled, and nothing in the file hangs on it: may be deleted (2026-11-20). */
  deletable?: boolean;
};

/** An invoice raised for this visit. */
export type RowInvoice = { id: string; number: string; status: string; total: string; amount_paid: string };

type Answer = { label?: string; labelAr?: string; value?: unknown };

export function AppointmentRow({
  slug,
  patientId,
  patientName,
  appointment: a,
  notes,
  categories,
  invoices,
  nextBookedAt,
  currency,
  tz,
  canInvoice,
  focused,
  onOpenChart,
  onTab,
}: {
  slug: string;
  patientId: string;
  patientName: string;
  appointment: RowAppointment;
  notes: NoteRow[];
  categories: NoteCategoryRow[];
  /** The invoices raised for this visit. */
  invoices: RowInvoice[];
  /** The patient's next booked visit after this one, for how this one was left. */
  nextBookedAt: string | null;
  currency: string;
  tz: string;
  /** May this member see and raise invoices? */
  canInvoice: boolean;
  /** Opened from the Treatment card: open, and in view. */
  focused: boolean;
  /** Show the dental chart — a visit's chart work opens there. */
  onOpenChart: () => void;
  /** Show another tab of the file. */
  onTab: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(focused);
  const self = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    self.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focused]);
  const work = useVisitWorkCount(a.id);
  // The visit's record: what it was, and the treatments no chart draws that were done at it.
  const treatment = useOptionalTreatmentStore();
  const faceWork = useChartWork().get(a.id)?.face ?? [];
  const record = treatment?.records.find((r) => r.appointmentId === a.id) ?? null;
  const doneHere = treatment ? standing(treatment.marks).filter((m) => m.appointmentId === a.id) : [];
  const recorded = hasText(record) || doneHere.length > 0;
  const rxHere = treatment?.prescriptions.filter((r) => r.appointment_id === a.id).length ?? 0;
  const filesHere = treatment?.files.filter((f) => f.appointment_id === a.id).length ?? 0;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const D = t.patients.visitDetails;

  const service = (locale === "ar" ? a.service_name_ar : null) || a.service_name;
  const room = (locale === "ar" ? a.room_name_ar : null) || a.room_name;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const at = (iso: string) => fmtTime(iso, tz, locale);
  const dt = (iso: string) => DateTime.fromISO(iso).setZone(tz).setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB").toFormat("ccc d LLL · H:mm");

  // Who booked it, worded as the calendar's panel words it.
  const bookedBy = a.walk_in
    ? a.created_by_name
      ? t.calendar.walkInBy.replace("{name}", a.created_by_name)
      : t.flow.walkInTag
    : a.source === "booking_link"
      ? a.booking_link_name
        ? t.calendar.bookedOnlineVia.replace("{link}", a.booking_link_name)
        : t.flow.bookedOnline
      : a.source === "ai_agent"
        ? t.calendar.bookedByAiFull
        : a.source === "automation"
          ? t.flow.bookedByAutomation
          : a.created_by_name
            ? t.calendar.bookedBy.replace("{name}", a.created_by_name)
            : "";
  const booked = bookedBy && a.created_at ? `${bookedBy} · ${dt(a.created_at)}` : bookedBy;

  // How the day went: arrived, waited, with the doctor, finished.
  const day: string[] = [];
  if (a.arrived_at) day.push(D.arrived.replace("{time}", at(a.arrived_at)));
  if (a.arrived_at && a.seated_at) day.push(D.waited.replace("{n}", String(minutesBetween(a.arrived_at, Date.parse(a.seated_at)))));
  if (a.seated_at) day.push(D.inRoom.replace("{time}", at(a.seated_at)));
  if (a.seated_at && a.finished_at) day.push(D.withDoctor.replace("{n}", String(minutesBetween(a.seated_at, Date.parse(a.finished_at)))));
  if (a.finished_at) day.push(D.finished.replace("{time}", at(a.finished_at)));

  const answers = (Array.isArray(a.intake_answers) ? (a.intake_answers as Answer[]) : [])
    .filter((x) => x.value !== undefined && x.value !== null && String(x.value).trim() !== "")
    .map((x) => `${(locale === "ar" ? x.labelAr : null) || x.label || ""}: ${Array.isArray(x.value) ? x.value.join("، ") : String(x.value)}`);

  // How it was left: the next visit, as the board's Finished card says it.
  const next = nextBookedAt
    ? t.finishVisit.bookedFor.replace("{when}", dt(nextBookedAt))
    : a.next_visit_days
      ? t.finishVisit.notBookedYet.replace("{when}", nextWhen(a.next_visit_days, t.finishVisit.inDays))
      : a.next_visit_none
        ? t.finishVisit.nextNone
        : "";
  const left = a.status === "completed" && (a.handed_off_at || nextBookedAt) ? next : "";

  const minutes = a.ends_at ? Math.round((Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 60000) : null;

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/c/${slug}/appointments/${a.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) return toast(t.common.genericError, "error");
      setDraft("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const chip = "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-sunken px-2 text-[length:max(11px,0.6875rem)] font-medium text-ink-500";
  const row = (label: string, value: React.ReactNode, key: string) => (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3" data-detail={key}>
      <dt className="text-[0.75rem] font-semibold text-ink-500">{label}</dt>
      <dd className="min-w-0 text-[0.84375rem] text-ink-900">{value}</dd>
    </div>
  );

  return (
    <li ref={self} data-appointment-row={a.id} data-appointment-focused={focused || undefined}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-start gap-3 px-5 py-3 text-start transition-colors hover:bg-ink-900/[0.02]">
        <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 text-ink-300 transition-transform rtl:rotate-180 ${open ? "rotate-90 rtl:rotate-90" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{service || "—"}</div>
          <div className="text-[0.8125rem] text-ink-500">
            {fmtDateTime(a.starts_at, tz, locale)}
            {a.doctor_name ? ` · ${a.doctor_name}` : ""}
          </div>
          {/* What the visit holds, in a row that wraps under the words: on a phone, beside them it crushed them. */}
          {(work > 0 || recorded || rxHere > 0 || filesHere > 0 || notes.length > 0 || invoices.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {recorded && (
                <span className={chip} data-visit-recorded={doneHere.length}>
                  <ClipboardPen className="h-3 w-3" />
                  {doneHere.length > 0 && <span className="tnum">{doneHere.length}</span>}
                </span>
              )}
              {work > 0 && (
                <span className={chip} data-visit-work-count={work}>
                  <Tooth className="h-3 w-3" />
                  <span className="tnum">{work}</span>
                </span>
              )}
              {notes.length > 0 && (
                <span className={chip}>
                  <StickyNote className="h-3 w-3" />
                  <span className="tnum">{notes.length}</span>
                </span>
              )}
              {invoices.length > 0 && (
                <span className={chip} data-visit-invoiced>
                  <ReceiptText className="h-3 w-3" />
                  {invoices[0].number}
                </span>
              )}
            </div>
          )}
        </div>
        <Badge status={apptStatus[a.status] ?? "neutral"}>{(t.calendar.statuses as Record<string, string>)[a.status] ?? a.status}</Badge>
      </button>

      {open && (
        <div className="grid gap-3 border-t border-line bg-sunken/30 px-5 py-3" data-appointment-details={a.id}>
          {/* The appointment itself: what was booked, by whom, and how the day went. */}
          <dl className="grid gap-2.5 rounded-lg border border-line bg-surface p-3">
            {row(D.when, <>{fmtDateTime(a.starts_at, tz, locale)}{a.ends_at ? ` – ${at(a.ends_at)}` : ""}{minutes ? <span className="text-ink-500"> · {D.minutes.replace("{n}", String(minutes))}</span> : null}</>, "when")}
            {service && row(D.services, <bdi>{service}</bdi>, "services")}
            {a.doctor_name && row(t.calendar.doctor, a.doctor_name, "doctor")}
            {room && row(t.calendar.room, room, "room")}
            {booked && row(D.booked, booked, "booked")}
            {day.length > 0 && row(D.atClinic, day.join(" · "), "day")}
            {!!a.late_min && row(D.late, D.lateBy.replace("{n}", String(a.late_min)), "late")}
            {(a.notes?.trim() || answers.length > 0) &&
              row(
                D.atBooking,
                <span className="grid gap-0.5" dir="auto">
                  {a.notes?.trim() ? <span className="whitespace-pre-wrap">{a.notes.trim()}</span> : null}
                  {answers.map((l, i) => (
                    <span key={i}>{l}</span>
                  ))}
                </span>,
                "booking"
              )}
            {(left || a.desk_note) &&
              row(
                D.handOff,
                <span className="grid gap-0.5">
                  {left ? <span className="font-semibold">{left}</span> : null}
                  {a.desk_note ? (
                    <span className="whitespace-pre-line text-ink-700" dir="auto">
                      {a.desk_note}
                    </span>
                  ) : null}
                </span>,
                "handoff"
              )}
            {canInvoice &&
              (invoices.length > 0 || a.status === "completed") &&
              row(
                D.invoice,
                invoices.length ? (
                  <span className="grid gap-1">
                    {invoices.map((i) => (
                      <Link key={i.id} href={`/c/${slug}/invoices/${i.id}`} className="inline-flex items-center gap-1.5 hover:text-brand-700" data-detail-invoice={i.id}>
                        <ReceiptText className="h-4 w-4 shrink-0 text-ink-500" />
                        <span className="font-medium">{i.number}</span>
                        <span className="text-ink-500">
                          · {fmtMoney(Number(i.total), currency, locale)} · {(t.invoices.statuses as Record<string, string>)[i.status] ?? i.status}
                        </span>
                      </Link>
                    ))}
                  </span>
                ) : (
                  <Link href={`/c/${slug}/invoices/new?patient=${patientId}&appointment=${a.id}`} className="font-semibold text-brand-700 hover:underline" data-detail-create-invoice>
                    {t.flow.createInvoice}
                  </Link>
                ),
                "invoice"
              )}
            <div className="pt-0.5">
              <Link href={`/c/${slug}/calendar?open=${a.id}`} className="inline-flex min-h-9 items-center gap-1.5 text-[0.8125rem] font-semibold text-brand-700 hover:underline" data-detail-calendar>
                <CalendarDays className="h-4 w-4" />
                {D.openInCalendar}
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          </dl>

          {/* What was found and done: the visit's record, with its prescription and files, as the Overview's Treatment card shows it. */}
          {treatment && (recorded || faceWork.length > 0 || rxHere > 0 || filesHere > 0 || treatment.canWrite) && (
            <div className="grid gap-2 rounded-lg border border-line bg-surface p-3" data-appointment-record={a.id}>
              <VisitRecordView appointmentId={a.id} record={record} marks={doneHere} chart={{ dental: 0, face: faceWork }} onTab={onTab} />
              {treatment.canWrite && !["cancelled", "no_show"].includes(a.status) && new Date(a.starts_at).getTime() < Date.now() + 86_400_000 && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => treatment.openSheet(a.id)} data-appointment-record-edit={a.id}>
                    <ClipboardPen className="h-4 w-4" />
                    {recorded ? t.treatment.edit : t.treatment.record}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* The visit's tooth work — planned for it, done at it. */}
          <div className="empty:hidden">
            <VisitWork appointmentId={a.id} onOpenChart={onOpenChart} />
          </div>

          {/* Whose visit and which one, restated where a note is about to be written. */}
          <div>
            <p className="mb-2 text-[0.75rem] text-ink-500">
              {patientName} · {fmtDateTime(a.starts_at, tz, locale)}
              {service ? ` · ${service}` : ""}
            </p>
            {notes.length === 0 ? (
              <p className="mb-2 text-[0.75rem] text-ink-400">{t.patients.notes.noVisitNotes}</p>
            ) : (
              <ul className="mb-2 grid gap-2">
                {notes.map((n) => {
                  const cat = n.category_id ? byId.get(n.category_id) : null;
                  return (
                    <li key={n.id} className="rounded-lg border border-line bg-surface p-2.5">
                      <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[length:max(11px,0.6875rem)] text-ink-400">
                        {cat && (
                          <span className="inline-flex h-4 items-center rounded-full px-1.5 font-semibold" style={{ color: cat.color, background: "var(--color-sunken)" }}>
                            {locale === "ar" ? cat.name_ar || cat.name : cat.name}
                          </span>
                        )}
                        {n.author ? `${n.author} · ` : ""}
                        {fmtDateTime(n.created_at, tz, locale)}
                        {n.edited_at ? ` · ${t.patients.notes.edited}` : ""}
                      </div>
                      {n.audio_path && <VoiceNote src={`/api/c/${slug}/notes/${n.id}/audio`} seconds={n.audio_seconds} label={t.patients.notes.playVoice} />}
                      {n.body && <p className="whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-ink-900">{n.body}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.patients.notes.addVisitNote} className="min-h-16 bg-surface" />
            <div className="mt-1.5 flex justify-end">
              <Button size="sm" onClick={add} loading={busy} disabled={!draft.trim() || busy}>
                {t.patients.notes.add}
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
