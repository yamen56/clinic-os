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
 *
 * Since 2026-11-25 the implants are not pinned to those teeth: each has a
 * place of its own along the jaw (implant-place.ts), and its tooth is the
 * nearest one. What goes on them — a bridge screwed to them, in one piece or
 * split, or a denture the patient takes out — is chosen, not told from how
 * many there are.
 */

import type { Arch } from "./teeth";
import { PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER } from "./teeth";
import { colOf, placeOf, sitesFor, defaultPlaces, whereText } from "./implant-place";
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

/** The last tooth a full arch's bridge may reach to: the second premolars, the first molars, the second molars. */
export const LAST_TEETH = [5, 6, 7] as const;

/** The arch's permanent teeth, as the chart draws them from the patient's right. */
export function archTeeth(arch: Arch): string[] {
  return arch === "upper" ? PERMANENT_UPPER : PERMANENT_LOWER;
}

/**
 * The teeth the prosthesis stands in for. A fixed bridge usually runs from
 * first molar to first molar; a denture, on implants or not, carries the
 * second molars too. `last` is the doctor's own choice.
 */
export function prosthesisSites(key: string, arch: Arch, implants: number, last?: number): string[] {
  const fixed = onImplants(key) && implants >= 4;
  const to = last ?? (fixed ? 6 : 7);
  return archTeeth(arch).filter((f) => Number(f[1]) <= to);
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

/** Every tooth in the order a group picks its lead by — the server sorts by it too. */
export const EVERY_TOOTH = [...PERMANENT_UPPER, ...PRIMARY_UPPER, ...PRIMARY_LOWER, ...PERMANENT_LOWER];

/**
 * Which member a group is listed, done and voided as: a full arch's entry on
 * the arch, otherwise the first tooth of a bridge, splint or partial denture
 * in chart order. Shared by the screen and the server, so both agree which
 * member carries the steps and the price.
 */
export function leadIdOf(members: { id: string; site: string }[]): string | null {
  if (!members.length) return null;
  const parent = members.find((m) => !isToothSite(m.site));
  if (parent) return parent.id;
  return [...members].sort((a, b) => EVERY_TOOTH.indexOf(a.site) - EVERY_TOOTH.indexOf(b.site) || a.id.localeCompare(b.id))[0].id;
}

/** The lead of every group. */
export function groupLeads(marks: Mark[]): Map<string, Mark> {
  const groups = new Map<string, Mark[]>();
  for (const m of marks) if (m.groupId) groups.set(m.groupId, [...(groups.get(m.groupId) ?? []), m]);
  const byId = new Map(marks.map((m) => [m.id, m]));
  const out = new Map<string, Mark>();
  for (const [g, ms] of groups) {
    const id = leadIdOf(ms);
    if (id) out.set(g, byId.get(id)!);
  }
  return out;
}

/** The entry this one is listed under, when it is one of a group's other members. */
export function leadOf(m: Mark, leads: Map<string, Mark>): Mark | null {
  if (!m.groupId) return null;
  const l = leads.get(m.groupId);
  return l && l.id !== m.id ? l : null;
}

const CHART_ORDER = [...PERMANENT_UPPER, ...PERMANENT_LOWER];

/** Teeth in the order the chart draws them, the patient's right first — how the list should read beside it. */
export function inChartOrder(sites: string[]): string[] {
  return [...sites].sort((a, b) => CHART_ORDER.indexOf(a) - CHART_ORDER.indexOf(b));
}

/** A full arch's implants, along the jaw from the patient's right. */
export function implantsOf(parent: Mark, marks: Mark[]): Mark[] {
  return marks
    .filter((m) => m.groupId === parent.groupId && m.id !== parent.id && !m.voidedAt && m.look === "implant")
    .sort((a, b) => placeOf(a).pos - placeOf(b).pos || colOf(a.site) - colOf(b.site));
}

/** "15", "12", "22", "25": the teeth a full arch's implants are nearest to, in chart order. */
export function implantSitesOf(parent: Mark, marks: Mark[]): string[] {
  return inChartOrder(implantsOf(parent, marks).map((m) => m.site));
}

/** The same, as a dentist would say it: "15 · 12 · 22–23 · 26", an implant between two teeth named by both. */
export function implantPlacesOf(parent: Mark, marks: Mark[]): string[] {
  return implantsOf(parent, marks).map((m) => whereText(parent.site as Arch, placeOf(m).pos));
}
