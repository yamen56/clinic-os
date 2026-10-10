/**
 * Work that replaces a whole arch: a bridge on four or six implants (All-on-4,
 * All-on-6), an overdenture on two, or a complete denture.
 *
 * It used to be one entry on the arch, drawn as a label beside it — the teeth
 * underneath never changed, and nothing said how many implants there were or
 * where. Now it is one group: a parent entry on the arch, which is what the
 * plan lists and what is done, voided and later priced; an implant entry on
 * each tooth that carries one; a bridge tooth on every tooth the prosthesis
 * stands in for; and the extractions of the teeth standing in the arch when it
 * is still to come. The drawing already knew how to draw all three on a
 * tooth, so the mouth finally shows the work.
 */

import type { Arch } from "./teeth";
import { PERMANENT_LOWER, PERMANENT_UPPER } from "./teeth";
import { isToothSite, type Mark, type ToothState } from "./state";

/** Treatments recorded as a whole-arch group. */
export const FULL_ARCH_KEYS: ReadonlySet<string> = new Set(["implant_denture", "denture_complete"]);

export function isFullArch(key: string): boolean {
  return FULL_ARCH_KEYS.has(key);
}

/** Does this treatment sit on implants (and so ask how many)? */
export function onImplants(key: string): boolean {
  return key === "implant_denture";
}

/** The counts offered first; any other is reached by tapping teeth. */
export const IMPLANT_COUNTS = [2, 4, 6] as const;

/**
 * Where the implants usually go, so the common case is one tap.
 *
 * Two: the canines, under an overdenture. Four (All-on-4): two straight at the
 * lateral incisors and two tilted at the second premolars. Six: lateral
 * incisors, first premolars and first molars.
 */
export function defaultImplantSites(arch: Arch, count: number): string[] {
  const [right, left] = arch === "upper" ? ["1", "2"] : ["4", "3"];
  const positions = count === 2 ? [3] : count === 6 ? [2, 4, 6] : [2, 5];
  return positions.flatMap((p) => [`${right}${p}`, `${left}${p}`]);
}

/** The arch's permanent teeth, as the chart draws them from the patient's right. */
export function archTeeth(arch: Arch): string[] {
  return arch === "upper" ? PERMANENT_UPPER : PERMANENT_LOWER;
}

/**
 * The teeth the prosthesis stands in for. A fixed bridge on four or more
 * implants runs from first molar to first molar; a denture, or an overdenture
 * on two implants, carries the second molars too.
 */
export function prosthesisSites(key: string, arch: Arch, implants: number): string[] {
  const fixed = onImplants(key) && implants >= 4;
  const last = fixed ? 6 : 7;
  return archTeeth(arch).filter((f) => Number(f[1]) <= last);
}

/**
 * The natural teeth still standing in an arch: not missing, not already out,
 * not buried in the bone, and not already planned for extraction. A full-arch
 * plan usually begins by taking these out.
 */
export function standingTeeth(arch: Arch, states: Map<string, ToothState>, marks: Mark[]): string[] {
  const out = new Set(
    marks.filter((m) => !m.voidedAt && m.look === "extraction" && isToothSite(m.site)).map((m) => m.site)
  );
  return archTeeth(arch).filter((f) => {
    const s = states.get(f);
    return !s?.gone && !s?.buried && !out.has(f);
  });
}

/** The parent of every group that has one: the member on the arch rather than on a tooth. */
export function groupParents(marks: Mark[]): Map<string, Mark> {
  const out = new Map<string, Mark>();
  for (const m of marks) if (m.groupId && !isToothSite(m.site)) out.set(m.groupId, m);
  return out;
}

/** The whole-arch entry this tooth's entry belongs to, if it is one of its teeth. */
export function parentOf(m: Mark, parents: Map<string, Mark>): Mark | null {
  if (!m.groupId) return null;
  const p = parents.get(m.groupId);
  return p && p.id !== m.id ? p : null;
}

const CHART_ORDER = [...PERMANENT_UPPER, ...PERMANENT_LOWER];

/** Teeth in the order the chart draws them, the patient's right first — how the list should read beside it. */
export function inChartOrder(sites: string[]): string[] {
  return [...sites].sort((a, b) => CHART_ORDER.indexOf(a) - CHART_ORDER.indexOf(b));
}

/** "15 · 12 · 22 · 25": the teeth carrying implants in a group, in chart order. */
export function implantSitesOf(parent: Mark, marks: Mark[]): string[] {
  return inChartOrder(
    marks.filter((m) => m.groupId === parent.groupId && m.id !== parent.id && !m.voidedAt && m.look === "implant").map((m) => m.site)
  );
}
