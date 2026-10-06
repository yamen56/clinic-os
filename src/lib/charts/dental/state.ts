/**
 * Chart entries, and the pure fold that turns them into what each tooth looks
 * like on a given day.
 *
 * An entry is a clinical record: it is never deleted, only voided, and the day
 * it was planned, done or voided is kept. That is what lets the chart be drawn
 * as it was at any earlier visit — the slider is this fold with a date.
 */

import { DateTime } from "luxon";
import type { EntryKind, Look } from "./catalog";
import type { Surface } from "./teeth";

export type Status = "planned" | "done" | "existing";
/** What the drawing is painted as: a procedure's status, or a finding. */
export type Paint = Status | "finding";

export type Person = { id: string; name: string };

export type Mark = {
  id: string;
  /** An FDI tooth ("16"), a quadrant ("Q1"…"Q4"), an arch ("upper", "lower") or "mouth". */
  site: string;
  surfaces: Surface[];
  treatmentKey: string;
  /** Names as they were when recorded, so renaming a treatment never rewrites a record. */
  label: string;
  labelAr: string;
  abbr?: string;
  look: Look;
  kind: EntryKind;
  detail: Record<string, string>;
  status: Status;
  /** Ties together the teeth of one bridge, splint or partial denture. */
  groupId?: string;
  /** In a bridge: a tooth that carries a crown, or a tooth the bridge replaces. */
  role?: "abutment" | "pontic";
  performedBy: Person | null;
  recordedBy: Person;
  createdAt: string;
  doneAt: string | null;
  voidedAt: string | null;
  voidedBy: Person | null;
  voidReason: string | null;
  note: string;
};

export type MarkEvent = {
  id: string;
  markId: string;
  action: "created" | "done" | "void" | "note" | "performer";
  at: string;
  by: Person;
  reason?: string;
};

export function isToothSite(site: string): boolean {
  return /^[1-8][1-8]$/.test(site);
}

/**
 * The entry as it stood at `at`: null when it did not exist yet or had been
 * voided, otherwise how it was painted. A planned entry later done reads as
 * planned on the days before it was done.
 */
export function paintAt(m: Mark, at: number | null): Paint | null {
  const now = at ?? Number.POSITIVE_INFINITY;
  if (Date.parse(m.createdAt) > now) return null;
  if (m.voidedAt && Date.parse(m.voidedAt) <= now) return null;
  if (m.kind === "finding") return "finding";
  if (m.status === "done") {
    if (m.doneAt && Date.parse(m.doneAt) > now) return "planned";
    return "done";
  }
  return m.status;
}

export type Layer = {
  markId: string;
  look: Look;
  paint: Paint;
  surfaces: Surface[];
  detail: Record<string, string>;
  role?: Mark["role"];
  groupId?: string;
};

export type ToothState = {
  /** The natural tooth is gone: missing, or extracted. Drawn as a ghost. */
  gone: boolean;
  /** Pushed into the bone: impacted or unerupted, with how it reads. */
  buried: { look: "impacted" | "unerupted"; paint: Paint } | null;
  layers: Layer[];
  /** Work with no shape on a tooth — an x-ray, a vitality test — as small markers. */
  dots: Paint[];
};

const EMPTY: ToothState = { gone: false, buried: null, layers: [], dots: [] };

/**
 * Every tooth's state on a day (`at` = null for now).
 *
 * Order matters only for drawing: layers come out in the order they were
 * recorded, so a crown recorded after a filling sits on top of it.
 */
export function toothStates(marks: Mark[], at: number | null): Map<string, ToothState> {
  const out = new Map<string, ToothState>();
  const sorted = [...marks].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const m of sorted) {
    if (!isToothSite(m.site)) continue;
    const paint = paintAt(m, at);
    if (!paint) continue;
    const s = out.get(m.site) ?? { gone: false, buried: null, layers: [], dots: [] };
    out.set(m.site, s);
    if (m.look === "missing") {
      s.gone = true;
      continue;
    }
    // Once an extraction has happened the tooth is simply not there; while it is
    // only planned, the tooth stays and wears a red cross.
    if (m.look === "extraction" && paint !== "planned") {
      s.gone = true;
      continue;
    }
    if (m.look === "impacted" || m.look === "unerupted") {
      s.buried = { look: m.look, paint };
      continue;
    }
    if (m.look === "dot") {
      s.dots.push(paint);
      continue;
    }
    // A pontic, an implant or a denture tooth stands where a tooth used to be.
    if (m.role === "pontic" || m.look === "implant" || m.look === "denture") {
      if (paint !== "planned") s.gone = true;
    }
    s.layers.push({ markId: m.id, look: m.look, paint, surfaces: m.surfaces, detail: m.detail, role: m.role, groupId: m.groupId });
  }
  return out;
}

export function stateOf(states: Map<string, ToothState>, fdi: string): ToothState {
  return states.get(fdi) ?? EMPTY;
}

/** The days anything happened, oldest first — the stops on the time slider. */
export function eventDays(marks: Mark[], tz: string): string[] {
  const days = new Set<string>();
  const day = (iso: string) => DateTime.fromISO(iso).setZone(tz).toISODate()!;
  for (const m of marks) {
    days.add(day(m.createdAt));
    if (m.doneAt) days.add(day(m.doneAt));
    if (m.voidedAt) days.add(day(m.voidedAt));
  }
  return [...days].sort();
}

/** The end of a clinic-local day, as an instant — "the mouth as it was that evening". */
export function endOfDay(day: string, tz: string): number {
  return DateTime.fromISO(day, { zone: tz }).endOf("day").toMillis();
}
