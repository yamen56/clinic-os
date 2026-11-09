"use client";

/*
  Treatments: the treatment coordinator's list for reception (a test, behind
  the opt-in `coordinator` feature — lib/courses). In the Due back list's place
  while the feature is on: the doctor's "come back in…" is one of its sources.

  Who is part-way through a treatment with nothing booked, and what the system
  did about it — booked automatically, due, or stalled (missed or cancelled
  its automatic booking, or a month overdue: a person's call). Book opens the
  booking on the due day at the time they usually come, with their doctor and
  service; Stop following leaves the treatments they have under way alone
  from now on, with Undo. The header's thirty days are what decide whether it
  leaves the test.
*/

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DateTime } from "luxon";
import { BellOff, CalendarPlus, MessageCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtDateOnly, fmtTime } from "@/lib/dates";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { buttonClass } from "@/components/ui/button-class";
import { Card, CardHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { CoordinatorStats, OpenTreatment } from "@/lib/courses";

type Data = {
  treatments: OpenTreatment[];
  stats: CoordinatorStats;
  consultation: { id: string; name: string; nameAr: string | null } | null;
};

export function TreatmentsList({
  slug,
  tz,
  canMessage,
  onBook,
}: {
  slug: string;
  tz: string;
  canMessage: boolean;
  onBook: (patient: { id: string; name: string }, opts: { doctorId?: string | null; serviceId?: string | null; start?: string }) => void;
}) {
  const { t, locale } = useI18n();
  const C = t.coordinator;
  const { toast } = useToast();
  const [data, setData] = useState<Data | null>(null);
  // Hidden the moment Stop is pressed, before the server answers.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    const res = await fetch(`/api/c/${slug}/treatments`, { cache: "no-store" });
    if (res.ok) setData((await res.json()) as Data);
  }, [slug]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRealtimeRefresh(slug, ["appointments"], refetch);

  const stop = async (row: OpenTreatment) => {
    setHidden((h) => new Set(h).add(row.patientId));
    const res = await fetch(`/api/c/${slug}/treatments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: row.patientId }),
    });
    if (!res.ok) {
      setHidden((h) => {
        const n = new Set(h);
        n.delete(row.patientId);
        return n;
      });
      toast(C.stopFailed, "error");
      return;
    }
    const { id } = (await res.json()) as { id: string };
    toast(C.stopped.replace("{name}", row.patientName), "success", {
      label: C.undo,
      onClick: () => {
        setHidden((h) => {
          const n = new Set(h);
          n.delete(row.patientId);
          return n;
        });
        void fetch(`/api/c/${slug}/treatments?id=${id}`, { method: "DELETE" }).then(refetch);
      },
    });
  };

  const book = (row: OpenTreatment) => {
    // The due day at the hour they usually come; today if it is already past.
    let start: string | undefined;
    if (row.lastAt) {
      const was = DateTime.fromISO(row.lastAt).setZone(tz);
      const today = DateTime.now().setZone(tz).startOf("day");
      let day = DateTime.fromISO(row.dueOn, { zone: tz });
      if (day < today) day = today;
      start = day.set({ hour: was.hour, minute: was.minute }).toISO() ?? undefined;
    }
    onBook({ id: row.patientId, name: row.patientName }, { doctorId: row.doctorId, serviceId: row.serviceId, start });
  };

  if (!data) return null;
  const rows = data.treatments.filter((r) => !hidden.has(r.patientId));
  const s = data.stats;
  const consult = data.consultation ? (locale === "ar" ? data.consultation.nameAr : null) || data.consultation.name : null;
  const today = DateTime.now().setZone(tz).toISODate()!;

  return (
    <div data-treatments className="mb-4">
      <Card>
        <CardHeader title={rows.length ? `${C.title} · ${rows.length}` : C.title} />
        <p className="-mt-2 px-5 pb-2 text-[12.5px] text-ink-500">{C.hint}</p>
        {/* The test's scorecard: of what it booked, how much was kept and how much undone. */}
        <dl className="mx-5 mb-3 grid grid-cols-3 gap-2 rounded-ctl bg-sunken p-3 text-center sm:grid-cols-6" data-coordinator-stats>
          {(
            [
              ["booked", s.booked],
              ["confirmed", s.confirmed],
              ["attended", s.attended],
              ["noShow", s.noShow],
              ["cancelled", s.cancelled],
              ["enquiries", `${s.enquiriesBooked}/${s.enquiries}`],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="truncate text-[11px] text-ink-500">{C.stats[k]}</dt>
              <dd className="text-[15px] font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="-mt-1 px-5 pb-3 text-[11.5px] text-ink-500">
          {C.statsWindow}
          {consult ? ` · ${C.consultationIs.replace("{service}", consult)}` : ` · ${C.noConsultation}`}
        </p>
        {rows.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-ink-500">{C.none}</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {rows.map((r) => {
              const name = (locale === "ar" ? r.nameAr : r.name) || r.name || r.nameAr;
              const session =
                r.total && r.done < r.total
                  ? C.session.replace("{n}", String(r.done + 1)).replace("{total}", String(r.total))
                  : C.source[r.source];
              const late = r.state === "due" && r.dueOn < today ? Math.round(DateTime.fromISO(today).diff(DateTime.fromISO(r.dueOn), "days").days) : 0;
              return (
                <li key={r.patientId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3" data-treatment-row={r.patientId} data-state={r.state}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="truncate text-sm font-semibold">{r.patientName}</span>
                      {/* A due one says so on its date line; the chip is for what that line does not say. */}
                      {(r.state !== "due" || r.action === "invite") && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            r.state === "stalled"
                              ? "bg-st-noshow-soft text-st-noshow"
                              : r.state === "auto_booked"
                                ? "bg-st-confirmed-soft text-st-confirmed"
                                : "bg-sunken text-ink-700"
                          }`}
                        >
                          {r.state === "due" ? C.state.invite : C.state[r.state as "stalled" | "auto_booked"]}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-[12.5px] text-ink-500">
                      <span>{session}</span>
                      {name && <span dir="auto">· {name}</span>}
                      {r.tooth && <span dir="ltr">· {r.tooth}</span>}
                      {r.others > 0 && <span>· {C.more.replace("{n}", String(r.others))}</span>}
                    </div>
                    <div className="text-[12.5px]">
                      {r.state === "auto_booked" && r.bookedAt ? (
                        <span className="text-ink-700">
                          {C.bookedFor.replace("{date}", fmtDate(r.bookedAt, tz, locale)).replace("{time}", fmtTime(r.bookedAt, tz, locale))}
                        </span>
                      ) : late > 0 ? (
                        <span className="font-semibold text-st-late">{t.finishVisit.overdue.replace("{n}", String(late))}</span>
                      ) : (
                        <span className="text-ink-700">{t.finishVisit.dueOn.replace("{date}", fmtDateOnly(r.dueOn, locale))}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5 max-sm:w-full">
                    {canMessage && (
                      <Link
                        href={`/c/${slug}/patients/${r.patientId}?tab=conversation`}
                        className={buttonClass({ variant: "outline", size: "sm", className: "max-sm:h-10 max-sm:flex-1" })}
                        aria-label={t.flow.whatsapp}
                      >
                        <MessageCircle className="h-4 w-4" />
                        <span className="max-sm:hidden">{t.flow.whatsapp}</span>
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => void stop(r)}
                      className={buttonClass({ variant: "outline", size: "sm", className: "max-sm:h-10 max-sm:flex-1" })}
                      data-treatment-stop
                    >
                      <BellOff className="h-4 w-4" />
                      {C.stop}
                    </button>
                    {r.state !== "auto_booked" && (
                      <button
                        type="button"
                        onClick={() => book(r)}
                        className={buttonClass({ size: "sm", className: "max-sm:h-10 max-sm:flex-1" })}
                        data-treatment-book
                      >
                        <CalendarPlus className="h-4 w-4" />
                        {t.flow.bookNext}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
