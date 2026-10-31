"use client";

/*
  Due back: the patients whose doctor asked for another visit that nobody has
  booked yet (lib/due-back). Above the waitlist, because both are the same job
  for reception — people to call and fit in.

  Book opens the booking on the day the doctor asked for, with that doctor
  and service (lib/next-visit). Booking anything later for them takes them off
  the list, live.
*/

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarPlus, MessageCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate } from "@/lib/dates";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { buttonClass } from "@/components/ui/button-class";
import { Card, CardHeader } from "@/components/ui/card";
import type { DueBack } from "@/lib/due-back";

export function DueBackList({
  slug,
  tz,
  canMessage,
  onBook,
}: {
  slug: string;
  tz: string;
  /** May open the patient's conversation. */
  canMessage: boolean;
  onBook: (d: DueBack) => void;
}) {
  const { t, locale } = useI18n();
  const F = t.finishVisit;
  const [due, setDue] = useState<DueBack[] | null>(null);
  const refetch = useCallback(async () => {
    const res = await fetch(`/api/c/${slug}/due-back`, { cache: "no-store" });
    if (res.ok) setDue(((await res.json()) as { due: DueBack[] }).due);
  }, [slug]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRealtimeRefresh(slug, ["appointments"], refetch);

  // Nothing to say until there is somebody: an empty card above the waitlist is noise.
  if (!due || due.length === 0) return null;

  return (
    <Card className="mb-4" data-due-back>
      <CardHeader title={`${F.dueBack} · ${due.length}`} />
      <p className="-mt-2 px-5 pb-2 text-[12.5px] text-ink-500">{F.dueBackHint}</p>
      <ul className="divide-y divide-line">
        {due.map((d) => {
          const service = (locale === "ar" ? d.serviceNameAr : null) || d.serviceName;
          return (
            <li key={d.patientId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3" data-due-back-row={d.patientId}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{d.patientName}</div>
                <div className="flex flex-wrap gap-x-2 text-[12.5px] text-ink-500">
                  <span className={d.daysLate > 0 ? "font-semibold text-st-late" : ""}>
                    {d.daysLate > 0 ? F.overdue.replace("{n}", String(d.daysLate)) : F.dueOn.replace("{date}", fmtDate(d.dueAt, tz, locale))}
                  </span>
                  {service && <span>· {service}</span>}
                  {d.doctorName && <span>· {d.doctorName}</span>}
                </div>
                {d.deskNote && (
                  <p dir="auto" className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-700">
                    {d.deskNote}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5 max-sm:w-full">
                {canMessage && (
                  <Link href={`/c/${slug}/patients/${d.patientId}?tab=conversation`} className={buttonClass({ variant: "outline", size: "sm", className: "max-sm:flex-1" })}>
                    <MessageCircle className="h-4 w-4" />
                    {t.flow.whatsapp}
                  </Link>
                )}
                <button type="button" onClick={() => onBook(d)} className={buttonClass({ size: "sm", className: "max-sm:flex-1" })} data-due-back-book>
                  <CalendarPlus className="h-4 w-4" />
                  {t.flow.bookNext}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
