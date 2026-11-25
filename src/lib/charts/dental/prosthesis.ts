/**
 * The prostheses in a mouth, as pieces: what the chart draws as one thing.
 *
 * A bridge used to be drawn tooth by tooth, as crowns joined by a line. It is
 * one piece, and so is a full arch's bridge or a denture — so they are worked
 * out here as pieces, from the same entries: which teeth each spans, what it
 * is made of, whether it is planned, under way or in the mouth, and how far
 * its steps have brought it (teeth prepared, a temporary in place). A full
 * arch's implants come with it, each where it really stands.
 *
 * Pure, and folded by day like the rest of the chart (paintAt), so the time
 * slider and "See the result" show the prostheses of that day too.
 */

import { isFullArch, leadIdOf } from "./full-arch";
import { colOf, placeOf, type Place } from "./implant-place";
import { isToothSite, paintAt, type Mark, type Paint } from "./state";
import type { StepRecord } from "./protocols";
import { tooth, type Arch } from "./teeth";

/** How far the work in the mouth has come when the piece itself is not in yet. */
export type Stage = "prep" | "temp";

export type PieceKind = "bridge" | "arch" | "denture";

export type PieceUnit = { fdi: string; col: number; role: "abutment" | "pontic"; markId: string };

export type Piece = {
  /** Unique on the chart: its group, and which run of it. */
  id: string;
  groupId: string;
  leadId: string;
  kind: PieceKind;
  arch: Arch;
  /** Its teeth, side by side, the patient's right first. */
  units: PieceUnit[];
  /** A full arch and a denture stand on a pink base; a bridge is teeth alone. */
  base: boolean;
  material: string | null;
  paint: Paint;
  stage: Stage | null;
  /** On implants, and screwed to them: the access holes show from above. */
  implants: Place[];
  /** Where it was split from the next section of the same arch: they touch there, and the base runs on. */
  seams: { left: boolean; right: boolean };
};

export type ArchImplant = {
  id: string;
  groupId: string;
  site: string;
  arch: Arch;
  place: Place;
  paint: Paint;
  /** What stands on it: a multi-unit abutment for a bridge, a healing cap for a denture. */
  top: "multi" | "heal";
};

export type Prostheses = { pieces: Piece[]; implants: ArchImplant[] };

/* ── Where a full arch's bridge is split ─────────────────────────────────── */

/*
  A full arch may be one bridge, or several, or crowns: the doctor splits it at
  the joints they choose. The joints are kept on the arch entry as a mask —
  bit n is the joint after column n — which fits in a detail whatever is split.
*/
export function cutsOf(detail: Record<string, string>): Set<number> {
  const mask = parseInt(detail.cuts ?? "", 16);
  const out = new Set<number>();
  if (!Number.isFinite(mask)) return out;
  for (let i = 0; i < 15; i++) if (mask & (1 << i)) out.add(i);
  return out;
}

export function cutsDetail(cuts: Iterable<number>): string {
  let mask = 0;
  for (const c of cuts) if (c >= 0 && c < 15) mask |= 1 << c;
  return mask.toString(16);
}

/** Fixed to its implants, or taken out by the patient: said on the entry, or told from the implants on older ones. */
export function archKind(parent: { treatmentKey: string; detail: Record<string, string> }, implants: number): "fixed" | "removable" {
  if (parent.treatmentKey !== "implant_denture") return "removable";
  if (parent.detail.kind === "fixed" || parent.detail.kind === "removable") return parent.detail.kind;
  return implants >= 4 ? "fixed" : "removable";
}

/* ── How far the steps have come ─────────────────────────────────────────── */

const PREP: Record<string, string> = { bridge: "prep", crown: "prep" };
const TEMP: Record<string, string> = { bridge: "temp", crown: "temp", implant_bridge: "temp", implant_denture: "temporary" };

/** Every treatment under way whose steps show in the mouth, on the day shown. */
export function stagesOf(marks: Mark[], steps: StepRecord[], at: number | null): Map<string, Stage> {
  const now = at ?? Number.POSITIVE_INFINITY;
  const out = new Map<string, Stage>();
  const byId = new Map(marks.map((m) => [m.id, m]));
  for (const s of steps) {
    if (Date.parse(s.doneAt) > now) continue;
    if (s.voidedAt && Date.parse(s.voidedAt) <= now) continue;
    const key = byId.get(s.markId)?.treatmentKey ?? "";
    if (TEMP[key] === s.step) out.set(s.markId, "temp");
    else if (PREP[key] === s.step && out.get(s.markId) !== "temp") out.set(s.markId, "prep");
  }
  // A bridge's steps are recorded on its lead and are the whole bridge's: every tooth of it is prepared with it.
  for (const [id, stage] of [...out]) {
    const lead = byId.get(id);
    if (!lead?.groupId) continue;
    for (const m of marks) if (m.groupId === lead.groupId && m.treatmentKey === lead.treatmentKey && !out.has(m.id)) out.set(m.id, stage);
  }
  return out;
}

/* ── The pieces ──────────────────────────────────────────────────────────── */

/** Teeth side by side, as runs: a gap, or a joint the doctor split, ends one. */
function runs(units: PieceUnit[], cuts: Set<number>): PieceUnit[][] {
  const sorted = [...units].sort((a, b) => a.col - b.col);
  const out: PieceUnit[][] = [];
  for (const u of sorted) {
    const last = out[out.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && u.col === prev.col + 1 && !cuts.has(prev.col)) last.push(u);
    else out.push([u]);
  }
  return out;
}

const NO_CUTS = new Set<number>();

/** Work under way shows on its lead; the teeth that follow it are still "planned" on their own rows. */
function groupPaint(own: Paint, lead: Paint | null): Paint {
  return own === "planned" && lead === "progress" ? "progress" : own;
}

export function prostheses(marks: Mark[], at: number | null, stages: Map<string, Stage> = new Map()): Prostheses {
  const groups = new Map<string, { m: Mark; paint: Paint }[]>();
  for (const m of marks) {
    if (!m.groupId) continue;
    const paint = paintAt(m, at);
    if (!paint) continue;
    groups.set(m.groupId, [...(groups.get(m.groupId) ?? []), { m, paint }]);
  }
  const pieces: Piece[] = [];
  const implants: ArchImplant[] = [];
  for (const [groupId, members] of groups) {
    const leadId = leadIdOf(members.map((x) => x.m));
    const lead = members.find((x) => x.m.id === leadId);
    if (!lead) continue;
    const stage = stages.get(lead.m.id) ?? null;
    const unitOf = (x: { m: Mark }): PieceUnit => ({ fdi: x.m.site, col: colOf(x.m.site), role: x.m.role ?? "abutment", markId: x.m.id });

    if (!isToothSite(lead.m.site) && isFullArch(lead.m.treatmentKey)) {
      const arch = lead.m.site as Arch;
      const teeth = members.filter((x) => x.m.role === "pontic" && colOf(x.m.site) >= 0);
      const placed = members.filter((x) => x.m.look === "implant" && colOf(x.m.site) >= 0);
      const kind = archKind(lead.m, placed.length);
      const fixed = lead.m.treatmentKey === "implant_denture" && kind === "fixed";
      const places = placed.map((x) => placeOf(x.m));
      for (const x of placed) {
        implants.push({ id: x.m.id, groupId, site: x.m.site, arch, place: placeOf(x.m), paint: groupPaint(x.paint, lead.paint === "progress" ? "progress" : null), top: fixed ? "multi" : "heal" });
      }
      if (!teeth.length) continue;
      // A bridge split at a joint is a piece on either side of it; a denture is never split.
      const cuts = fixed ? cutsOf(lead.m.detail) : NO_CUTS;
      const taken = new Set(teeth.map((x) => colOf(x.m.site)));
      for (const [i, run] of runs(teeth.map(unitOf), cuts).entries()) {
        pieces.push({
          id: `${groupId}-${i}`,
          seams: { left: taken.has(run[0].col - 1), right: taken.has(run[run.length - 1].col + 1) },
          groupId,
          leadId: lead.m.id,
          kind: fixed ? "arch" : "denture",
          arch,
          units: run,
          base: true,
          material: lead.m.detail.material ?? null,
          paint: groupPaint(teeth[0].paint, lead.paint),
          stage,
          implants: fixed ? places.filter((p) => p.pos >= run[0].col - 0.5 && p.pos <= run[run.length - 1].col + 0.5) : [],
        });
      }
      continue;
    }

    // A bridge on teeth or implants, or a partial denture: the teeth themselves are the group.
    const teeth = members.filter((x) => isToothSite(x.m.site) && colOf(x.m.site) >= 0 && (x.m.look === "denture" || (x.m.look === "crown" && !!x.m.role)));
    if (!teeth.length) continue;
    const kind: PieceKind = teeth[0].m.look === "denture" ? "denture" : "bridge";
    for (const arch of ["upper", "lower"] as Arch[]) {
      const here = teeth.filter((x) => tooth(x.m.site).arch === arch);
      for (const [i, run] of runs(here.map(unitOf), NO_CUTS).entries()) {
        if (kind === "bridge" && run.length < 2) continue;
        pieces.push({
          id: `${groupId}-${arch}${i}`,
          groupId,
          leadId: lead.m.id,
          kind,
          arch,
          units: run,
          base: kind === "denture",
          material: teeth[0].m.detail.material ?? null,
          paint: groupPaint(here[0].paint, lead.paint),
          stage,
          implants: [],
          seams: { left: false, right: false },
        });
      }
    }
  }
  return { pieces, implants };
}

/** The entries a piece or an arch's implant draws, so the tooth under it does not draw them again. */
export function drawnByPieces(p: Prostheses): Set<string> {
  const out = new Set<string>();
  for (const x of p.pieces) for (const u of x.units) out.add(u.markId);
  for (const i of p.implants) out.add(i.id);
  return out;
}
