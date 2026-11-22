"use client";

/*
  Due back: the patients whose doctor asked for another visit that nobody has
  booked yet (lib/due-back). Above the waitlist, because both are the same job
  for reception — people to call and fit in.

  A call list, so each row carries what a call needs: the number to tap, the
  WhatsApp thread, and Book, which opens the booking with that doctor and
  service on the day the doctor asked for — or today, once that day has gone
  (2026-11-22: it opened on the overdue day itself, in the past). Somebody who
  said "not now" or went elsewhere comes off the list with the ✕, with Undo.
  Booking anything later for them takes them off on its own, live.

  Always drawn, empty too, with how somebody gets onto it: a list that hides
  when empty is a feature nobody can tell is there.
*/

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarPlus, MessageCircle, Phone, X, CalendarClock } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { buttonClass } from "@/components/ui/button-class";
import { Card, CardHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { DueBack } from "@/lib/due-back";

export function DueBackList({
  slug,
  tz,
  canMessage,
  canOpenPatient = false,
  onBook,
  onCount,
}: {
  slug: string;
  tz: string;
  /** May open the patient's conversation. */
  canMessage: boolean;
  /** May open the patient's file. */
  canOpenPatient?: boolean;
  onBook: (d: DueBack) => void;
  /** How many are due now or overdue — the tab's badge. */
  onCount?: (n: number) => void;
}) {
  const { t, locale } = useI18n();
  const F = t.finishVisit;
  const { toast } = useToast();
  const [due, setDue] = useState<DueBack[] | null>(null);
  // Off the list the moment ✕ is pressed, before the server answers.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const refetch = useCallback(async () => {
    const res = await fetch(`/api/c/${slug}/due-back`, { cache: "no-store" });
    if (res.ok) setDue(((await res.json()) as { due: DueBack[] }).due);
  }, [slug]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRealtimeRefresh(slug, ["appointments"], refetch);

  const rows = (due ?? []).filter((d) => !hidden.has(d.appointmentId));
  const now = rows.filter((d) => d.daysLate >= 0);
  const soon = rows.filter((d) => d.daysLate < 0);
  useEffect(() => {
    if (due) onCount?.(now.length);
  }, [due, now.length, onCount]);

  const post = (appointmentId: string, undo: boolean) =>
    fetch(`/api/c/${slug}/due-back`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appointmentId, undo }),
    });
  const unhide = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.delete(id);
      return n;
    });
  const dismiss = async (d: DueBack) => {
    setHidden((h) => new Set(h).add(d.appointmentId));
    const res = await post(d.appointmentId, false);
    if (!res.ok) {
      unhide(d.appointmentId);
      toast(t.common.genericError, "error");
      return;
    }
    toast(F.dueRemoved.replace("{name}", d.patientName), "success", {
      label: F.dueUndo,
      onClick: () => {
        unhide(d.appointmentId);
        void post(d.appointmentId, true).then(refetch);
      },
    });
  };

  if (!due) return null;

  const row = (d: DueBack) => {
    const service = (locale === "ar" ? d.serviceNameAr : null) || d.serviceName;
    const phone = d.phone?.replace(/[^\d+]/g, "");
    return (
      <li key={d.appointmentId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3" data-due-back-row={d.patientId}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            {canOpenPatient ? (
              <Link href={`/c/${slug}/patients/${d.patientId}`} className="truncate text-sm font-semibold hover:underline">
                {d.patientName}
              </Link>
            ) : (
              <span className="truncate text-sm font-semibold">{d.patientName}</span>
            )}
            {d.phone && <span className="num shrink-0 text-[0.75rem] text-ink-400 tnum">{formatPhone(d.phone)}</span>}
          </div>
          <div className="flex flex-wrap gap-x-2 text-[0.78125rem] text-ink-500">
            <span className={d.daysLate > 0 ? "font-semibold text-st-late" : d.daysLate === 0 ? "font-semibold text-ink-900" : ""} data-due-when>
              {d.daysLate > 0
                ? F.overdue.replace("{n}", String(d.daysLate))
                : d.daysLate === 0
                  ? F.dueToday
                  : F.dueOn.replace("{date}", fmtDate(d.dueAt, tz, locale))}
            </span>
            {service && <span>· {service}</span>}
            {d.doctorName && <span>· {d.doctorName}</span>}
          </div>
          {d.deskNote && (
            <p dir="auto" className="mt-0.5 line-clamp-2 text-[0.78125rem] text-ink-700">
              {d.deskNote}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full">
          {phone && (
            <a href={`tel:${phone}`} className={buttonClass({ variant: "outline", size: "sm", className: "max-sm:flex-1" })} data-due-back-call>
              <Phone className="h-4 w-4" />
              {t.flow.call}
            </a>
          )}
          {canMessage && (
            <Link
              href={`/c/${slug}/patients/${d.patientId}?tab=conversation`}
              className={buttonClass({ variant: "outline", size: "sm", className: "max-sm:flex-1" })}
            >
              <MessageCircle className="h-4 w-4" />
              {t.flow.whatsapp}
            </Link>
          )}
          <button type="button" onClick={() => onBook(d)} className={buttonClass({ size: "sm", className: "max-sm:flex-1" })} data-due-back-book>
            <CalendarPlus className="h-4 w-4" />
            {t.flow.bookNext}
          </button>
          <button
            type="button"
            aria-label={F.dueRemove}
            title={F.dueRemove}
            onClick={() => void dismiss(d)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-300 transition-colors hover:bg-danger-soft hover:text-danger"
            data-due-back-remove
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </li>
    );
  };

  return (
    <div data-due-back className="mb-4">
      <Card>
        <CardHeader title={now.length ? `${F.dueBack} · ${now.length}` : F.dueBack} />
        <p className="-mt-2 px-5 pb-2 text-[0.78125rem] text-ink-500">{F.dueBackHint}</p>
        {rows.length === 0 ? (
          <div className="flex items-start gap-2.5 border-t border-line px-5 py-4 text-[0.8125rem] text-ink-500" data-due-back-empty>
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
            <span>
              <span className="block font-medium text-ink-700">{F.noneDue}</span>
              {F.dueBackHow}
            </span>
          </div>
        ) : (
          <>
            {now.length > 0 && <ul className="divide-y divide-line border-t border-line">{now.map(row)}</ul>}
            {soon.length > 0 && (
              <>
                <div className="border-t border-line bg-sunken/60 px-5 py-1.5 text-[length:max(11px,0.71875rem)] font-semibold text-ink-500" data-due-back-soon>
                  {F.dueSoon.replace("{n}", String(soon.length))}
                </div>
                <ul className="divide-y divide-line border-t border-line">{soon.map(row)}</ul>
              </>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
