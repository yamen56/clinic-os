/**
 * Setting up a bridge: which teeth it runs across, and which carry it.
 *
 * A bridge used to be tapped out tooth by tooth on the chart, and planned
 * after an extraction it was recorded on one tooth — which is not a bridge.
 * The chart already knows where the gap is and what stands beside it, so it
 * proposes the span and the doctor corrects it: the missing teeth and one
 * support each side, or from one implant to the next.
 */

import { archTeeth } from "./full-arch";
import { colOf } from "./implant-place";
import { stateOf, type ToothState } from "./state";
import { tooth } from "./teeth";

export type BridgeRole = "abutment" | "pontic";
export type BridgeTooth = { site: string; role: BridgeRole };

/** The two bridges: on teeth, and on implants. */
export function isBridge(key: string): boolean {
  return key === "bridge" || key === "implant_bridge";
}

/** Is there an implant here, placed or planned? */
export function hasImplant(st: ToothState): boolean {
  return st.layers.some((l) => l.look === "implant" && !l.arch);
}

/** No tooth to hold a bridge: it is gone, buried, or about to be taken out. */
function empty(st: ToothState): boolean {
  return (st.gone || !!st.buried || st.layers.some((l) => l.look === "extraction")) && !hasImplant(st);
}

/** What a tooth of a bridge would be: what carries it, or what it replaces. */
export function roleAt(site: string, states: Map<string, ToothState>): BridgeRole {
  return empty(stateOf(states, site)) ? "pontic" : "abutment";
}

/** The teeth from one column to another, with their parts. */
export function spanOf(arch: "upper" | "lower", from: number, to: number, states: Map<string, ToothState>): BridgeTooth[] {
  return archTeeth(arch)
    .slice(Math.max(0, Math.min(from, to)), Math.min(15, Math.max(from, to)) + 1)
    .map((site) => ({ site, role: roleAt(site, states) }));
}

/**
 * The span to propose from the teeth in hand. Two or more: from the first to
 * the last. One: across the gap it is in or beside, with a support either
 * side; from an implant, to the next implant when only missing teeth lie
 * between them.
 */
export function suggestSpan(seed: string[], states: Map<string, ToothState>): BridgeTooth[] {
  const sites = seed.filter((s) => colOf(s) >= 0);
  if (!sites.length) return [];
  const arch = tooth(sites[0]).arch;
  const cols = sites.filter((s) => tooth(s).arch === arch).map(colOf);
  if (cols.length > 1) return spanOf(arch, Math.min(...cols), Math.max(...cols), states);
  const row = archTeeth(arch);
  const at = cols[0];
  const st = (c: number) => stateOf(states, row[c]);
  const bare = (c: number) => c >= 0 && c <= 15 && empty(st(c));
  const implant = (c: number) => c >= 0 && c <= 15 && hasImplant(st(c));
  const holds = (c: number) => c >= 0 && c <= 15 && !empty(st(c));

  if (bare(at)) {
    let a = at;
    let b = at;
    while (bare(a - 1)) a--;
    while (bare(b + 1)) b++;
    return spanOf(arch, holds(a - 1) ? a - 1 : a, holds(b + 1) ? b + 1 : b, states);
  }
  if (implant(at)) {
    // To the nearest implant with nothing standing between them.
    for (let d = 1; d <= 6; d++) {
      for (const dir of [1, -1]) {
        const c = at + dir * d;
        if (!implant(c)) continue;
        let clear = true;
        for (let k = 1; k < d; k++) if (!bare(at + dir * k)) clear = false;
        if (clear) return spanOf(arch, at, c, states);
      }
    }
    // None: it carries the missing tooth beside it.
    const dir = bare(at + 1) ? 1 : bare(at - 1) ? -1 : 0;
    if (dir) return spanOf(arch, at, at + dir, states);
  }
  // A standing tooth: across the gap beside it, when there is one.
  for (const dir of [1, -1]) {
    if (!bare(at + dir)) continue;
    let c = at + dir;
    while (bare(c + dir)) c += dir;
    return spanOf(arch, at, holds(c + dir) ? c + dir : c, states);
  }
  return spanOf(arch, at, at < 15 ? at + 1 : at - 1, states);
}

/** What is wrong with a bridge as it stands, or null. */
export function bridgeProblem(teeth: BridgeTooth[]): "few" | "support" | null {
  if (teeth.length < 2) return "few";
  if (!teeth.some((x) => x.role === "abutment")) return "support";
  return null;
}

/** On implants as soon as one of its supports is one. */
export function bridgeKey(teeth: BridgeTooth[], states: Map<string, ToothState>): "bridge" | "implant_bridge" {
  return teeth.some((x) => x.role === "abutment" && hasImplant(stateOf(states, x.site))) ? "implant_bridge" : "bridge";
}
