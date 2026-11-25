/**
 * Where an implant of a full arch really is.
 *
 * A dentist, 2026-11-25: in the real procedure they do not choose a tooth for
 * each implant — it may sit a little to the right or the left, between two
 * teeth, and tilted, to find the bone. So a full arch's implant has a place of
 * its own: how far along the jaw, how it leans, how deep, how long and how
 * wide. It still carries a tooth number (`site`) — the nearest one no other
 * implant of the arch has — because that is how everything else on the chart
 * finds it: the lists, the steps, the invoice.
 *
 * Places are kept on the entry's `detail`, as text like every detail. An
 * implant recorded before 2026-11-25 has none, and stands at its tooth.
 *
 * Pure, and shared by the screen and the server: the server clamps what it is
 * sent with the same numbers the screen drags within.
 */

import type { Arch } from "./teeth";
import { PERMANENT_LOWER, PERMANENT_UPPER } from "./teeth";

export type Place = {
  /** Along the jaw, in teeth as the chart draws them: 0 is the middle of 18 (or 48), 15 of 28 (or 38). */
  pos: number;
  /** Degrees. Positive leans the implant's tip toward the patient's left — the chart's right — in both jaws. */
  tilt: number;
  /** Millimetres below the usual level; negative stands higher. */
  depth: number;
  /** Millimetres. */
  len: number;
  dia: number;
};

export const LENGTHS = [6, 8, 10, 11.5, 13, 15, 18] as const;
export const DIAMETERS = [3.3, 3.5, 3.75, 4.1, 4.5, 5] as const;
export const DEFAULT_LEN = 11.5;
export const DEFAULT_DIA = 4.1;
export const MAX_TILT = 60;
export const DEPTHS = { min: -2, max: 5 } as const;
/** The nearest two implants may stand, middle to middle, in teeth: closer and they would touch. */
export const MIN_GAP = 0.6;
export const MAX_IMPLANTS = 10;
/** The angles an angled abutment is made at: a tilt near one settles on it. */
const DETENTS = [0, 17, 30, 45];

const row = (arch: Arch) => (arch === "upper" ? PERMANENT_UPPER : PERMANENT_LOWER);

/** A tooth's place in its arch: 0 to 15, the patient's right first. -1 for a baby tooth. */
export function colOf(fdi: string): number {
  const i = PERMANENT_UPPER.indexOf(fdi);
  return i >= 0 ? i : PERMANENT_LOWER.indexOf(fdi);
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampPlace(p: Place): Place {
  return {
    pos: Number(clamp(p.pos, 0, 15).toFixed(2)),
    tilt: Math.round(clamp(p.tilt, -MAX_TILT, MAX_TILT)),
    depth: round(clamp(p.depth, DEPTHS.min, DEPTHS.max), 0.5),
    len: clamp(p.len, LENGTHS[0], LENGTHS[LENGTHS.length - 1]),
    dia: clamp(p.dia, 3, 6),
  };
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The place an entry carries, or null when it has none of its own. */
export function placeIn(detail: Record<string, string>): Place | null {
  const pos = num(detail.pos);
  if (pos === null) return null;
  return clampPlace({ pos, tilt: num(detail.tilt) ?? 0, depth: num(detail.depth) ?? 0, len: num(detail.len) ?? DEFAULT_LEN, dia: num(detail.dia) ?? DEFAULT_DIA });
}

/** An implant's place: its own, or straight at its tooth when it has none. */
export function placeOf(m: { site: string; detail: Record<string, string> }): Place {
  return placeIn(m.detail) ?? { pos: Math.max(0, colOf(m.site)), tilt: 0, depth: 0, len: DEFAULT_LEN, dia: DEFAULT_DIA };
}

const text = (v: number) => String(Number(v.toFixed(2)));

/** A place as an entry keeps it. */
export function placeDetail(p: Place): Record<string, string> {
  const c = clampPlace(p);
  return { pos: text(c.pos), tilt: text(c.tilt), depth: text(c.depth), len: text(c.len), dia: text(c.dia) };
}

/** Is this a tilt an abutment is made for? Within a couple of degrees it settles on it; further, it is left alone. */
export function snapTilt(deg: number): number {
  for (const d of DETENTS) {
    if (Math.abs(Math.abs(deg) - d) <= 2) return d === 0 ? 0 : Math.sign(deg) * d;
  }
  return Math.round(deg);
}

/**
 * How far along the jaw this implant may go from where its neighbours stand.
 * It cannot pass through one: to have them the other way round, the other is
 * moved.
 */
export function boundedPos(places: Place[], index: number, pos: number): number {
  const here = places[index].pos;
  let lo = 0;
  let hi = 15;
  places.forEach((p, i) => {
    if (i === index) return;
    if (p.pos <= here) lo = Math.max(lo, p.pos + MIN_GAP);
    else hi = Math.min(hi, p.pos - MIN_GAP);
  });
  return lo > hi ? here : Number(clamp(pos, lo, hi).toFixed(2));
}

/**
 * A tooth number for each implant, none used twice: the nearest to the nearest
 * first, so an implant right at a tooth keeps that tooth's number when another
 * one leans in from between.
 */
export function sitesFor(arch: Arch, places: Place[]): string[] {
  const teeth = row(arch);
  const order = places.map((p, i) => ({ i, off: Math.abs(p.pos - Math.round(p.pos)) })).sort((a, b) => a.off - b.off || a.i - b.i);
  const taken = new Set<number>();
  const out: string[] = new Array(places.length).fill("");
  for (const { i } of order) {
    const p = places[i].pos;
    const free = teeth.map((_, c) => c).filter((c) => !taken.has(c));
    const c = free.sort((a, b) => Math.abs(a - p) - Math.abs(b - p) || a - b)[0];
    taken.add(c);
    out[i] = teeth[c];
  }
  return out;
}

/** The teeth an implant stands at or between: one name when it is at a tooth, two when it is between them. */
export function teethAt(arch: Arch, pos: number): string[] {
  const teeth = row(arch);
  const near = clamp(Math.round(pos), 0, 15);
  if (Math.abs(pos - near) <= 0.22) return [teeth[near]];
  const a = clamp(Math.floor(pos), 0, 14);
  return [teeth[a], teeth[a + 1]];
}

/** "15", or "15–14" when it stands between them. */
export function whereText(arch: Arch, pos: number): string {
  return teethAt(arch, pos).join("–");
}

/** Which way the tip leans: toward the midline, toward the back of the jaw, or neither. */
export function leanOf(pos: number, tilt: number): "straight" | "midline" | "back" {
  if (tilt === 0) return "straight";
  return pos < 7.5 === tilt > 0 ? "midline" : "back";
}

/**
 * Where the implants usually go, so the common case needs no placing at all.
 *
 * Two: the canines, under an overdenture. Four (All-on-4): two straight at the
 * lateral incisors and two at the second premolars leaning back from the sinus
 * or the nerve, their tips thirty degrees toward the midline. Six: lateral
 * incisors, first premolars and first molars.
 */
export function defaultPlaces(arch: Arch, count: number): Place[] {
  const at = (position: number, right: boolean, tilt = 0, len: number = DEFAULT_LEN): Place => ({
    pos: right ? 8 - position : 7 + position,
    tilt: right ? tilt : tilt === 0 ? 0 : -tilt,
    depth: 0,
    len,
    dia: DEFAULT_DIA,
  });
  const pairs: [number, number, number][] =
    count === 2
      ? [[3, 0, DEFAULT_LEN]]
      : count === 6
        ? [
            [2, 0, DEFAULT_LEN],
            [4, 0, DEFAULT_LEN],
            [6, 0, 10],
          ]
        : [
            [2, 0, DEFAULT_LEN],
            [5, 30, 13],
          ];
  const out = pairs.flatMap(([p, t, l]) => [at(p, true, t, l), at(p, false, t, l)]);
  return inOrder(out);
}

/** Along the jaw, the patient's right first. */
export function inOrder<T extends { pos: number }>(places: T[]): T[] {
  return [...places].sort((a, b) => a.pos - b.pos);
}

/** Room for one more: the middle of the widest gap, from the last molar on one side to the other. Null when there is none. */
export function nextPlace(places: Place[]): Place | null {
  if (places.length >= MAX_IMPLANTS) return null;
  if (places.length === 0) return { pos: 7.5, tilt: 0, depth: 0, len: DEFAULT_LEN, dia: DEFAULT_DIA };
  const stops = [0.5, ...inOrder(places).map((p) => p.pos), 14.5];
  let best = -1;
  let at = 0;
  for (let i = 1; i < stops.length; i++) {
    const gap = stops[i] - stops[i - 1];
    if (gap > best) {
      best = gap;
      at = (stops[i] + stops[i - 1]) / 2;
    }
  }
  if (best < MIN_GAP * 2) return null;
  return { pos: Number(at.toFixed(2)), tilt: 0, depth: 0, len: DEFAULT_LEN, dia: DEFAULT_DIA };
}
