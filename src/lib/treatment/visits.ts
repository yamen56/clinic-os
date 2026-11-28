/**
 * The treatment record as a list of visits.
 *
 * A visit's entry is everything recorded about it: what it was (the record)
 * and what was done at it (the treatments no chart draws). Work written on a
 * day the patient had no appointment stands by its date, as one entry for the
 * day. A visit whose only work is on a chart is an entry too — named by the
 * caller, which holds the charts — so a dental clinic's record lists every
 * visit something was done at, without that work being entered here.
 */

import { DateTime } from "luxon";
import type { GeneralMark, VisitRecord } from "./db";
import { hasVitals } from "./vitals";

export type EntryVisit = {
  id: string;
  starts_at: string;
  status: string;
  service_name: string | null;
  service_name_ar: string | null;
  doctor_name: string | null;
};

export type Entry = {
  /** The appointment's id, or `day:2026-11-15` for work with no visit. */
  key: string;
  appointmentId: string | null;
  at: string;
  visit: EntryVisit | null;
  record: VisitRecord | null;
  /** Done at it, standing, in the order recorded. */
  marks: GeneralMark[];
};

/** Whether a record says anything. One with every part cleared reads as not written; vital signs alone count. */
export function hasText(r: VisitRecord | null | undefined): boolean {
  return !!r && ([r.complaint, r.exam, r.diagnosis, r.plan].some((x) => x.trim() !== "") || hasVitals(r.vitals));
}

export const dayOf = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toISODate()!;

/** The treatments planned for a later visit and not done yet, oldest first. */
export const planned = (marks: GeneralMark[]) => marks.filter((m) => !m.voidedAt && m.status === "planned").sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

/**
 * The plan the visit before this one left: the latest record before `at`
 * that wrote one. A follow-up is read against it — "review in a week" is why
 * the patient is here.
 */
export function lastPlanBefore(
  records: VisitRecord[],
  visits: EntryVisit[],
  exceptId: string,
  at: string
): { plan: string; at: string } | null {
  const byVisit = new Map(visits.map((v) => [v.id, v]));
  const whenOf = (r: VisitRecord) => (r.appointmentId ? byVisit.get(r.appointmentId)?.starts_at : undefined) ?? r.createdAt;
  const before = records
    .filter((r) => r.id !== exceptId && r.plan.trim() && Date.parse(whenOf(r)) < Date.parse(at))
    .sort((a, b) => Date.parse(whenOf(b)) - Date.parse(whenOf(a)))[0];
  return before ? { plan: before.plan.trim(), at: whenOf(before) } : null;
}

/** The treatments done and still standing. */
export const standing = (marks: GeneralMark[]) => marks.filter((m) => !m.voidedAt && m.status === "done");

export function buildEntries(
  records: VisitRecord[],
  marks: GeneralMark[],
  visits: EntryVisit[],
  tz: string,
  /** Visits a chart has work at. */
  chartVisits: Iterable<string> = []
): Entry[] {
  const byVisit = new Map(visits.map((v) => [v.id, v]));
  const entries = new Map<string, Entry>();
  const entryFor = (appointmentId: string | null, at: string): Entry => {
    const visit = appointmentId ? (byVisit.get(appointmentId) ?? null) : null;
    const key = visit ? visit.id : `day:${dayOf(at, tz)}`;
    let e = entries.get(key);
    if (!e) {
      e = { key, appointmentId: visit?.id ?? null, at: visit?.starts_at ?? at, visit, record: null, marks: [] };
      entries.set(key, e);
    } else if (!visit && Date.parse(at) < Date.parse(e.at)) {
      e.at = at;
    }
    return e;
  };

  for (const r of records) {
    if (!hasText(r)) continue;
    const e = entryFor(r.appointmentId, r.createdAt);
    // A day with no visit could hold two records; the later one is the day's.
    if (!e.record || Date.parse(r.updatedAt) > Date.parse(e.record.updatedAt)) e.record = r;
  }
  for (const m of standing(marks)) entryFor(m.appointmentId, m.doneAt ?? m.createdAt).marks.push(m);
  for (const id of chartVisits) {
    const v = byVisit.get(id);
    if (v) entryFor(id, v.starts_at);
  }
  return [...entries.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * The visit a record is written against when nobody named one: today's, the
 * one in progress first. Null when the patient has none today.
 */
export function todaysVisitId(visits: EntryVisit[], tz: string, now = Date.now()): string | null {
  const today = DateTime.fromMillis(now).setZone(tz).toISODate();
  const mine = visits
    .filter((v) => !["cancelled", "no_show"].includes(v.status) && dayOf(v.starts_at, tz) === today)
    .sort((a, b) => Math.abs(Date.parse(a.starts_at) - now) - Math.abs(Date.parse(b.starts_at) - now));
  return mine[0]?.id ?? null;
}
