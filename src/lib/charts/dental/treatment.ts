/**
 * A patient's treatment over time: the visits it took, and the arithmetic the
 * chart and the printed record share.
 */

import { DateTime } from "luxon";
import { EMERGENCY_STEP, type StepRecord } from "./protocols";

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


/** A treatment as a visit lists it: what was done to it there, its steps in order. */
export type VisitLine = {
  markId: string;
  site: string;
  label: string;
  labelAr: string | null;
  treatmentKey: string;
  /** The steps done at the visit, in order; empty for work done in one go. */
  steps: string[];
  at: string;
};

type Listed = { id: string; site: string; label: string; labelAr?: string | null; treatmentKey: string; groupId?: string | null };

/**
 * What was done at a visit, one line per treatment — a full arch or a bridge
 * under its lead, as the chart lists it, with the steps done there after it.
 * Not a line for every tooth of an arch, nor for every step of a root canal.
 */
export function visitLines(
  work: { markId: string; step: string | null; at: string }[],
  marks: Map<string, Listed>,
  leadOfGroup: (groupId: string) => string | null
): VisitLine[] {
  const lines = new Map<string, VisitLine>();
  for (const w of [...work].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const m = marks.get(w.markId);
    if (!m) continue;
    const lead = (m.groupId && marks.get(leadOfGroup(m.groupId) ?? "")) || m;
    const line = lines.get(lead.id) ?? {
      markId: lead.id,
      site: lead.site,
      label: lead.label,
      labelAr: lead.labelAr ?? null,
      treatmentKey: lead.treatmentKey,
      steps: [],
      at: w.at,
    };
    if (w.step && !line.steps.includes(w.step)) line.steps.push(w.step);
    lines.set(lead.id, line);
  }
  return [...lines.values()];
}
