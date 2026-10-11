/**
 * A patient's treatment: the cases it is made of, the visits it took, and the
 * arithmetic both tabs and the printed record share.
 *
 * A case is one problem and what is done about it: what brought the patient
 * in, its history, the examination, the diagnosis, and the plan — the chart
 * entries filed under it. A new problem next year is a new case, with its own
 * history, diagnosis and plan; the old one stays as it was.
 */

import { DateTime } from "luxon";
import type { Mark, Person } from "./state";
import { EMERGENCY_STEP, type StepRecord } from "./protocols";

export type TreatmentCase = {
  id: string;
  title: string;
  complaint: string;
  history: string;
  exam: string;
  diagnosis: string;
  doctor: Person | null;
  status: "open" | "closed";
  medicalReviewedAt: string | null;
  medicalReviewedBy: Person | null;
  createdBy: Person;
  createdAt: string;
  closedAt: string | null;
};

/** A visit of the patient's, as the treatment needs it. */
export type Visit = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  doctor: string | null;
  service: string | null;
};

/** A plan item booked into a visit. */
export type Booking = { markId: string; appointmentId: string };

const LIVE = new Set(["pending_approval", "scheduled", "confirmed"]);

/** A visit still to come and still on. */
export function isUpcoming(v: Visit, now = Date.now()): boolean {
  return LIVE.has(v.status) && Date.parse(v.endsAt) > now;
}

/** The visit this item is next booked into, if it is. */
export function nextVisitOf(markId: string, bookings: Booking[], visits: Visit[], now = Date.now()): Visit | null {
  const ids = new Set(bookings.filter((b) => b.markId === markId).map((b) => b.appointmentId));
  return (
    visits
      .filter((v) => ids.has(v.id) && isUpcoming(v, now))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0] ?? null
  );
}

/**
 * Which visit a step belongs to: the day it was done, in the clinic's own
 * time. One day in the chair is one visit, whether it was booked or a
 * walk-in, and however many times the patient sat down that day — the way a
 * clinic counts sessions, and charges for them.
 */
export function sessionKey(s: { doneAt: string }, tz: string): string {
  return `day:${DateTime.fromISO(s.doneAt).setZone(tz).toISODate()}`;
}

/**
 * How many sessions a treatment took: the days on which any of its steps
 * were done. An emergency on a day of its own is counted apart — a visit,
 * but not one of the treatment's own.
 */
export function sessionsOf(steps: StepRecord[], tz: string): { sessions: number; emergencies: number } {
  const own = new Set<string>();
  const urgent = new Set<string>();
  for (const s of steps) {
    if (s.voidedAt) continue;
    (s.step === EMERGENCY_STEP ? urgent : own).add(sessionKey(s, tz));
  }
  return { sessions: own.size, emergencies: [...urgent].filter((k) => !own.has(k)).length };
}

/** The case's label when it has no title: what brought the patient in, shortened. */
export function caseName(c: TreatmentCase): string {
  const t = c.title.trim() || c.complaint.trim();
  if (!t) return "";
  const line = t.split(/\n/)[0];
  return line.length > 48 ? `${line.slice(0, 46)}…` : line;
}

/** The entries of a case, or of none when the id is null — the work charted before cases existed. */
export function marksOfCase(marks: Mark[], caseId: string | null): Mark[] {
  return marks.filter((m) => m.caseId === caseId);
}
