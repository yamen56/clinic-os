import { DateTime } from "luxon";
import { hmToMin, rangesForDay, type WeeklyHours } from "@/lib/hours";

/** Pixels per minute. A 90px drag is an hour — qa-phase3 drags exactly that. */
export const PX = 1.5;
/** Drag and resize snap, in minutes. */
export const SNAP = 15;

export type Lane = { lane: number; lanes: number };

/**
 * Side by side, not on top of each other.
 *
 * Two visits at ten o'clock in one column used to be drawn in the same place,
 * the second hiding the first entirely — a double booking looked exactly like
 * a single one. Each run of overlapping visits now shares the column's width:
 * every visit takes the first free lane, and every visit in the run is as
 * wide as the run needs.
 */
export function layoutLanes(items: { id: string; start: number; end: number }[]): Map<string, Lane> {
  const out = new Map<string, Lane>();
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const c of cluster) out.set(c.id, { lane: c.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };
  for (const it of sorted) {
    if (it.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else {
      laneEnds[lane] = it.end;
    }
    cluster.push({ id: it.id, lane });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

/**
 * The hours worth drawing: the clinic's day with an hour either side, widened
 * to whatever is actually booked outside it. A clinic open 9–5 no longer
 * scrolls through seven empty evening hours to reach a Thursday late visit,
 * and a visit booked at 7am is never off the edge of the grid.
 */
export function visibleRange(
  hoursList: WeeklyHours[],
  days: DateTime[],
  appts: { starts_at: string; ends_at: string }[],
  tz: string
): { startMin: number; endMin: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of hoursList) {
    for (const d of days) {
      for (const [open, close] of rangesForDay(h, d)) {
        lo = Math.min(lo, hmToMin(open));
        hi = Math.max(hi, hmToMin(close));
      }
    }
  }
  for (const a of appts) {
    const s = DateTime.fromISO(a.starts_at).setZone(tz);
    const e = DateTime.fromISO(a.ends_at).setZone(tz);
    lo = Math.min(lo, s.hour * 60 + s.minute);
    hi = Math.max(hi, e.hasSame(s, "day") ? e.hour * 60 + e.minute : 24 * 60);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { startMin: 8 * 60, endMin: 20 * 60 };
  const startMin = Math.max(0, Math.floor((lo - 60) / 60) * 60);
  const endMin = Math.min(24 * 60, Math.ceil((hi + 60) / 60) * 60);
  return { startMin, endMin: Math.max(endMin, startMin + 4 * 60) };
}

/** A colour at a fraction over the surface, for the soft fill of a calendar block. */
export function tint(color: string, pct: number): string {
  return `color-mix(in oklab, ${color} ${pct}%, var(--color-surface))`;
}
