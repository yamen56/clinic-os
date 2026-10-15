/**
 * Doing a treatment again.
 *
 * A dentist, 2026-10-15: a patient comes back and says something is wrong
 * with work done before — the crown came loose and cracked, the root canal
 * flares up. The work is done again, and a crown may be replaced two or three
 * times in a patient's life, a root canal re-treated more than once.
 *
 * A redo is a new treatment pointing at the one it redoes (`redoOf`): its own
 * steps, its own price — which the doctor can set to nothing when it is on
 * the clinic — and its own line on the tooth. The old work is left exactly as
 * it was, because it was done; the tooth's history reads crown, redo, redo.
 */

import { isToothSite, type Mark } from "./state";

/** What a redo is recorded as: a root canal done again is a retreatment. */
const REDO_AS: Record<string, string> = { rct: "rct_retreat" };

export function redoKey(treatmentKey: string): string {
  return REDO_AS[treatmentKey] ?? treatmentKey;
}

/** Work that is not done again — it is gone, or it has no shape on the tooth to fail. */
const NOT_REDONE = new Set(["extraction", "missing", "dot"]);

/**
 * Can this work be done again? Work done here or already there, still
 * standing and still in the mouth: not an extraction or an exam, and not a
 * part of a full arch (that is the arch's to redo, as a whole).
 */
export function redoable(m: Mark, marks: Mark[]): boolean {
  if (m.kind !== "procedure" || m.voidedAt || m.status === "planned") return false;
  if (NOT_REDONE.has(m.look) || m.treatmentKey === "implant_denture") return false;
  if (m.groupId && marks.some((x) => x.groupId === m.groupId && !x.voidedAt && !isToothSite(x.site))) return false;
  return true;
}

/** The redo of this work, if one was started (the latest, when it was redone more than once). */
export function redoneBy(m: Mark, marks: Mark[]): Mark | null {
  return (
    marks
      .filter((x) => x.redoOf === m.id && !x.voidedAt)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
}

/** Which time this is: 1 for the first, 2 for the first redo, and so on back along the chain. */
export function attemptOf(m: Mark, marks: Mark[]): number {
  let n = 1;
  let cur: Mark | undefined = m;
  const seen = new Set<string>();
  while (cur?.redoOf && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = marks.find((x) => x.id === cur!.redoOf);
    if (!cur) break;
    n++;
  }
  return n;
}

/** The work a redo can be started on, on these teeth: once per bridge, the newest first. */
export function redoCandidates(teeth: string[], marks: Mark[]): Mark[] {
  const seenGroups = new Set<string>();
  return marks
    .filter((m) => teeth.includes(m.site) && redoable(m, marks))
    .sort((a, b) => Date.parse(b.doneAt ?? b.createdAt) - Date.parse(a.doneAt ?? a.createdAt))
    .filter((m) => {
      if (!m.groupId) return true;
      if (seenGroups.has(m.groupId)) return false;
      seenGroups.add(m.groupId);
      return true;
    });
}
