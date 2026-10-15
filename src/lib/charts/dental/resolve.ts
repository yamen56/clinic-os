/**
 * Findings that treatment has answered.
 *
 * Yamen, 2026-10-15: "when we find caries and we added, above the caries, a
 * composite filling, so supposedly we have solved the problem. We need, as a
 * default, for the caries to disappear. And apply the same thing for other
 * findings and treatments."
 *
 * A finding is answered by work done on its tooth after it was found: caries
 * on the surfaces a filling covers (the rest still shows), a fracture by a
 * crown, a periapical lesion by the root canal, recession by a gum graft, a
 * missing tooth by the implant or bridge tooth that replaces it — and
 * everything on a tooth that has since been taken out. Planned work answers
 * nothing until it is done, and work recorded before the finding never
 * answers it (recurrent caries under an old filling is new).
 *
 * The finding is not voided: it is the record of what was found. It is drawn
 * no more, and its tooth lists it as resolved, by what and when. The time
 * slider reads this with a date, so the mouth before the filling still shows
 * its caries.
 */

import { tooth, type Surface } from "./teeth";
import { isToothSite, paintAt, type Mark } from "./state";

/** What done work covers of a finding on its tooth: the whole finding, some surfaces of it, or nothing. */
type Cover = "all" | Surface[] | null;

function covers(f: Mark, w: Mark): Cover {
  // The tooth is out: whatever was found on it went with it.
  if (w.look === "extraction") return "all";
  const crowned = (w.look === "crown" && w.role !== "pontic") || w.look === "core" || w.look === "post";
  switch (f.look) {
    case "caries":
      if (w.look === "filling" || w.look === "inlay") return w.surfaces;
      if (crowned) return "all";
      // A veneer covers the face it is bonded to.
      return w.look === "veneer" ? ["B"] : null;
    case "fracture":
      if (crowned || w.look === "inlay") return "all";
      // A crack is held by a crown or an onlay; a broken edge is built up too.
      if (f.treatmentKey === "crack") return null;
      return w.look === "filling" || w.look === "veneer" ? "all" : null;
    case "lesion":
      return w.look === "rct" || w.look === "apico" ? "all" : null;
    case "wear":
      return crowned || w.look === "inlay" || w.look === "veneer" ? "all" : null;
    case "stain":
      return (w.look === "crown" && w.role !== "pontic") || w.look === "veneer" ? "all" : null;
    case "recession":
      return w.treatmentKey === "gum_graft" ? "all" : null;
    case "missing":
      return w.look === "implant" || w.look === "denture" || w.role === "pontic" ? "all" : null;
    case "dot":
      return f.treatmentKey === "diastema" && (w.look === "veneer" || w.look === "filling" || crowned) ? "all" : null;
    default:
      return null;
  }
}

/** Does work recorded on a site reach this tooth? The tooth itself — or, for whitening, the mouth or arch it is in. */
function reaches(w: Mark, f: Mark): boolean {
  if (w.site === f.site) return true;
  if (w.treatmentKey !== "whitening" || f.treatmentKey !== "discoloration" || isToothSite(w.site)) return false;
  const t = tooth(f.site);
  return w.site === "mouth" || w.site === t.arch || w.site === `Q${((t.quadrant - 1) % 4) + 1}`;
}

export type Resolution = {
  /** The work that answered it — the last that covered any of it. */
  by: Mark;
  /** The surfaces still showing; empty when it is answered in full. */
  left: Surface[];
};

/**
 * Every finding that later work has answered, in full or on some surfaces,
 * as the mouth stood at `at` (null for now). A finding nothing reached is
 * not in the map.
 */
export function resolutions(marks: Mark[], at: number | null): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  const findings = marks.filter((m) => m.kind === "finding" && isToothSite(m.site) && paintAt(m, at));
  if (!findings.length) return out;
  const work = marks
    .filter((m) => m.kind === "procedure" && m.doneAt && paintAt(m, at) === "done")
    .sort((a, b) => Date.parse(a.doneAt!) - Date.parse(b.doneAt!));
  for (const f of findings) {
    const found = Date.parse(f.createdAt);
    // A surface finding is answered surface by surface; a tooth finding as a whole.
    let left: Surface[] | null = f.surfaces.length ? [...f.surfaces] : null;
    let by: Mark | null = null;
    for (const w of work) {
      if (Date.parse(w.doneAt!) < found || !reaches(w, f)) continue;
      const c = w.treatmentKey === "whitening" ? "all" : covers(f, w);
      if (!c) continue;
      if (c === "all") {
        left = [];
        by = w;
        break;
      }
      if (!left) continue;
      const next = left.filter((s) => !c.includes(s));
      if (next.length < left.length) {
        left = next;
        by = w;
      }
      if (!left.length) break;
    }
    if (by) out.set(f.id, { by, left: left ?? [] });
  }
  return out;
}
