"use client";

/*
  The visit in progress, over the patient's file.

  The file did not know the patient was in the clinic: the doctor opened it,
  worked, then went back to the calendar to call them in or finish. While the
  patient is waiting or in the room this says so, with how long, and carries
  the one step that moves them on — Call in, or Finish visit, which asks for
  the hand-off to the desk (components/appointments/finish-visit-sheet).

  Held here once pressed rather than re-read: the step is answered at once,
  and a move made on the board elsewhere reaches it through the realtime
  stream, for this visit only.
*/

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Clock, DoorOpen } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { minutesBetween } from "@/lib/patient-flow";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { FinishVisitSheet } from "@/components/appointments/finish-visit-sheet";
import { nextVisitHref } from "@/lib/next-visit";
import { DateTime } from "luxon";
import { setFlowAction, type Handoff } from "../../calendar/flow-actions";

export type VisitNow = {
  id: string;
  starts_at: string;
  service_id: string | null;
  arrived_at: string | null;
  seated_at: string | null;
  doctor_member_id: string | null;
  service_name: string | null;
  service_name_ar: string | null;
  service_duration_min: number | null;
  room_name: string | null;
  room_name_ar: string | null;
};

export function VisitBanner({
  slug,
  tz,
  patientId,
  visit,
  patientName,
  canFlow,
}: {
  slug: string;
  tz: string;
  patientId: string;
  visit: VisitNow;
  patientName: string;
  canFlow: boolean;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [seatedAt, setSeatedAt] = useState(visit.seated_at);
  const [finished, setFinished] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setSeatedAt(visit.seated_at), [visit.seated_at]);
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(h);
  }, []);
  useRealtimeRefresh(slug, ["appointments"], () => router.refresh(), (e) => e.id === visit.id);

  if (finished) return null;
  const inRoom = !!seatedAt;
  const since = minutesBetween((inRoom ? seatedAt : visit.arrived_at) ?? new Date().toISOString(), now);
  const room = (locale === "ar" ? visit.room_name_ar : null) || visit.room_name;
  const service = (locale === "ar" ? visit.service_name_ar : null) || visit.service_name;

  const fail = (e?: string) => toast(e === "not_today" ? t.flow.notToday : t.flow.stale, "error");

  const callIn = async () => {
    setBusy(true);
    setSeatedAt(new Date().toISOString());
    const r = await setFlowAction(slug, visit.id, "seated");
    setBusy(false);
    if (r.error) {
      setSeatedAt(null);
      if (r.error === "room_occupied") toast(t.flow.roomOccupied.replace("{name}", r.occupiedBy ?? ""), "error");
      else fail(r.error);
    }
  };

  /** `another`: "Another time…" — finished, then the calendar's booking on the day asked for. */
  const finish = async (handoff: Handoff | null, another?: boolean) => {
    setBusy(true);
    const r = await setFlowAction(slug, visit.id, "finished", handoff ? { handoff } : {});
    setBusy(false);
    if (r.error) return fail(r.error);
    setFinishing(false);
    setFinished(true);
    if (r.booked) {
      toast(
        t.finishVisit.finishedBooked.replace(
          "{when}",
          DateTime.fromISO(r.booked.startsAt).setZone(tz).setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB").toFormat("ccc d LLL · H:mm")
        )
      );
    } else if (r.bookError) {
      toast(t.finishVisit.bookFailed, "error");
    } else {
      toast(t.finishVisit.finished);
    }
    if (handoff && (another || r.bookError)) {
      router.push(nextVisitHref(slug, { patient_id: patientId, starts_at: visit.starts_at, doctor_member_id: visit.doctor_member_id, service_id: visit.service_id }, handoff, tz));
    }
  };

  return (
    <>
      <div
        className={`mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border px-4 py-3 ${
          inRoom ? "border-st-inroom/30 bg-st-inroom-soft" : "border-st-waiting/30 bg-st-waiting-soft"
        }`}
        data-visit-banner={inRoom ? "in_room" : "waiting"}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[14px] font-semibold text-ink-900">
          {inRoom ? <DoorOpen className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 truncate">
            {inRoom ? (room ? t.visitBanner.inRoomNamed.replace("{room}", room) : t.visitBanner.inRoom) : t.visitBanner.waiting}
            <span className="font-normal text-ink-700"> · {t.visitBanner.minutes.replace("{n}", String(since))}</span>
            {service ? <span className="font-normal text-ink-500"> · {service}</span> : null}
          </span>
        </div>
        {canFlow &&
          (inRoom ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setFinishing(true)}
              className="inline-flex h-10 touch-manipulation items-center gap-1.5 rounded-full bg-brand-600 px-4 text-[13px] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-60 max-sm:flex-1 max-sm:justify-center"
              data-visit-finish
            >
              <CheckCheck className="h-4 w-4" />
              {t.finishVisit.finish}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={callIn}
              className="inline-flex h-10 touch-manipulation items-center gap-1.5 rounded-full bg-brand-600 px-4 text-[13px] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-60 max-sm:flex-1 max-sm:justify-center"
              data-visit-call-in
            >
              <DoorOpen className="h-4 w-4" />
              {t.flow.callIn}
            </button>
          ))}
      </div>
      {finishing && (
        <FinishVisitSheet
          slug={slug}
          tz={tz}
          serviceId={visit.service_id}
          onAnotherTime={(h) => void finish(h, true)}
          patientName={patientName}
          serviceName={service}
          defaultDoctorId={visit.doctor_member_id}
          defaultMinutes={visit.service_duration_min}
          busy={busy}
          onFinish={(h) => void finish(h)}
          onClose={() => setFinishing(false)}
        />
      )}
    </>
  );
}
