import { DateTime } from "luxon";

/**
 * The next visit a finished one asked for (migration 0088), as a booking
 * starts: the doctor's "in two weeks" from the day of the visit, at the hour it
 * was booked for, with the doctor they named or the same one, for the same
 * service. Without a hand-off it is what Book next always was: same doctor,
 * same service, the time left to whoever books.
 *
 * Pure, so the board, the visit panel and the Due back list all suggest the
 * same day.
 */
export function nextVisitOf(
  a: {
    starts_at: string;
    finished_at?: string | null;
    doctor_member_id: string | null;
    service_id: string | null;
    next_visit_days?: number | null;
    next_visit_member_id?: string | null;
  },
  tz: string
): { doctorId: string | null; serviceId: string | null; start?: string } {
  const doctorId = a.next_visit_member_id ?? a.doctor_member_id;
  if (!a.next_visit_days) return { doctorId, serviceId: a.service_id };
  const booked = DateTime.fromISO(a.starts_at).setZone(tz);
  const day = DateTime.fromISO(a.finished_at ?? a.starts_at).setZone(tz).plus({ days: a.next_visit_days });
  const start = day.set({ hour: booked.hour, minute: booked.minute, second: 0, millisecond: 0 });
  return { doctorId, serviceId: a.service_id, start: start.toISO() ?? undefined };
}

/**
 * The calendar's booking, opened for the next visit a finished one asked for —
 * for the screens that have no booking panel of their own (the dashboard's
 * Today list, the visit banner on a patient's file).
 */
export function nextVisitHref(
  slug: string,
  a: { patient_id: string; starts_at: string; doctor_member_id: string | null; service_id: string | null },
  h: { nextDays: number | null; nextMemberId: string | null },
  tz: string
): string {
  const n = nextVisitOf(
    { ...a, finished_at: new Date().toISOString(), next_visit_days: h.nextDays, next_visit_member_id: h.nextMemberId },
    tz
  );
  const q = new URLSearchParams({ tab: "schedule", patient: a.patient_id });
  if (n.doctorId) q.set("doctor", n.doctorId);
  if (n.serviceId) q.set("service", n.serviceId);
  if (n.start) {
    q.set("date", DateTime.fromISO(n.start).setZone(tz).toISODate()!);
    q.set("at", n.start);
  }
  return `/c/${slug}/calendar?${q}`;
}

/** "2 weeks", "6 months" — the chip's own words for a chip's number, plain days otherwise. */
export function nextWhen(days: number, words: Record<string, string>): string {
  return words[String(days)] ?? `${days}`;
}
