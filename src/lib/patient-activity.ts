/**
 * A patient's Recent activity, as staff would say it.
 *
 * The audit log stores codes — `patient.view`, `dental.mark.create`,
 * `lab_case.received` — and the file used to print them as they are, so the
 * card read "view · view · view" in both languages. This turns each code into a
 * phrase from the dictionary and folds a run of the same thing by the same
 * person into one line: a doctor opening a file five times between patients is
 * one fact, and it was pushing every real change off the card.
 *
 * Codes are matched exactly first, then by family (`dental.`, `face.`,
 * `lab_case.`), so a new chart operation reads as "Updated the dental chart"
 * rather than leaking its code onto the screen.
 */

export type ActivityKey =
  | "view"
  | "create"
  | "update"
  | "status"
  | "merge"
  | "export"
  | "waitlist"
  | "allergyOverride"
  | "imaging"
  | "imagingForget"
  | "dentalMark"
  | "dentalDone"
  | "dentalStep"
  | "dentalUndo"
  | "dental"
  | "faceMark"
  | "faceUndo"
  | "face"
  | "packageSell"
  | "noCharge"
  | "labSend"
  | "labBack"
  | "labCancel"
  | "lab"
  | "other";

const EXACT: Record<string, ActivityKey> = {
  "patient.view": "view",
  "patient.create": "create",
  "patient.update": "update",
  "patient.status": "status",
  "patient.merge": "merge",
  "patient.export": "export",
  "waitlist.add": "waitlist",
  "prescription.allergy_override": "allergyOverride",
  "imaging.request": "imaging",
  "imaging.link.forget": "imagingForget",
  "dental.mark.create": "dentalMark",
  "dental.mark.done": "dentalDone",
  "dental.step.create": "dentalStep",
  "dental.mark.undo": "dentalUndo",
  "dental.step.undo": "dentalUndo",
  "face.mark.create": "faceMark",
  "face.mark.undo": "faceUndo",
  "face.package.sell": "packageSell",
  "chart.mark.no_charge": "noCharge",
  "lab_case.send": "labSend",
  "lab_case.received": "labBack",
  "lab_case.cancel": "labCancel",
};

export function activityKey(action: string): ActivityKey {
  const exact = EXACT[action];
  if (exact) return exact;
  if (action.startsWith("dental.")) return "dental";
  if (action.startsWith("face.")) return "face";
  if (action.startsWith("lab_case.")) return "lab";
  return "other";
}

export type ActivityRow = { action: string; created_at: string; actor: string | null };
export type ActivityLine = { key: ActivityKey; actor: string | null; at: string; count: number };

/**
 * Newest first in, newest first out. Neighbouring rows that say the same thing
 * about the same person become one line carrying the newest time and a count.
 */
export function foldActivity(rows: ActivityRow[], limit: number): ActivityLine[] {
  const out: ActivityLine[] = [];
  for (const r of rows) {
    const key = activityKey(r.action);
    const last = out[out.length - 1];
    if (last && last.key === key && last.actor === r.actor) {
      last.count++;
      continue;
    }
    if (out.length === limit) break;
    out.push({ key, actor: r.actor, at: r.created_at, count: 1 });
  }
  return out;
}
