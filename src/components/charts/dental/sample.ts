/*
  A made-up mouth for the preview: four visits over five months, two dentists
  and an assistant, with something of everything — existing work, findings,
  plans carried out, a bridge, an implant on the way, a wisdom tooth to come
  out and one entry voided because it went on the wrong tooth. Enough that the
  drawing, the colours and the time slider can be judged on a real-looking case.
*/

import { BUILT_IN_BY_KEY } from "@/lib/charts/dental/catalog";
import type { Surface } from "@/lib/charts/dental/teeth";
import type { Mark, MarkEvent, Person, Status } from "@/lib/charts/dental/state";
import type { Favorite } from "./treatment-picker";

export function samplePeople(locale: string) {
  const ar = locale === "ar";
  return {
    sara: { id: "sample-sara", name: ar ? "د. سارة حدّاد" : "Dr. Sara Haddad" },
    omar: { id: "sample-omar", name: ar ? "د. عمر خليل" : "Dr. Omar Khalil" },
    lina: { id: "sample-lina", name: ar ? "لينا (مساعدة)" : "Lina (assistant)" },
  };
}

export function sampleMouth(locale: string, now = Date.now()): { marks: Mark[]; events: MarkEvent[]; favorites: Favorite[] } {
  const P = samplePeople(locale);
  const day = (ago: number, hour = 10) => {
    const d = new Date(now - ago * 86400000);
    d.setHours(hour, 15, 0, 0);
    return d.toISOString();
  };
  const v1 = day(150);
  const v2 = day(92, 11);
  const v3 = day(33, 12);
  const v4 = day(6, 16);

  const marks: Mark[] = [];
  const events: MarkEvent[] = [];
  let n = 0;
  const mk = (
    key: string,
    site: string,
    o: {
      at: string;
      status?: Status;
      done?: string;
      by?: Person;
      rec?: Person;
      surfaces?: Surface[];
      detail?: Record<string, string>;
      groupId?: string;
      role?: Mark["role"];
      voided?: { at: string; by: Person; reason: string };
      note?: string;
    }
  ) => {
    const tr = BUILT_IN_BY_KEY.get(key)!;
    const id = `s${++n}`;
    const status: Status = tr.kind === "finding" ? "existing" : (o.status ?? (o.done ? "done" : "planned"));
    const doneAt = status === "done" ? (o.done ?? o.at) : null;
    const by = o.by ?? P.sara;
    marks.push({
      id,
      site,
      surfaces: o.surfaces ?? [],
      treatmentKey: key,
      label: tr.en,
      labelAr: tr.ar,
      abbr: tr.abbr,
      look: tr.look,
      kind: tr.kind,
      detail: o.detail ?? {},
      status,
      groupId: o.groupId,
      role: o.role,
      performedBy: by,
      recordedBy: o.rec ?? by,
      createdAt: o.at,
      doneAt,
      voidedAt: o.voided?.at ?? null,
      voidedBy: o.voided?.by ?? null,
      voidReason: o.voided?.reason ?? null,
      note: o.note ?? "",
    });
    events.push({ id: `e${n}a`, markId: id, action: "created", at: o.at, by: o.rec ?? by });
    if (doneAt && doneAt !== o.at) events.push({ id: `e${n}b`, markId: id, action: "done", at: doneAt, by: o.rec ?? by });
    if (o.voided) events.push({ id: `e${n}c`, markId: id, action: "void", at: o.voided.at, by: o.voided.by, reason: o.voided.reason });
  };

  // Visit 1 — first examination: what the patient arrived with.
  mk("exam_comprehensive", "mouth", { at: v1, done: v1 });
  mk("xray_opg", "mouth", { at: v1, done: v1, rec: P.lina });
  mk("missing", "18", { at: v1 });
  mk("missing", "48", { at: v1 });
  mk("missing", "14", { at: v1 });
  mk("impacted", "38", { at: v1 });
  mk("extraction_wisdom", "38", { at: v1, by: P.omar, note: locale === "ar" ? "بعد انتهاء علاج الرحى 36" : "After the 36 root canal is finished" });
  mk("crown", "17", { at: v1, status: "existing", detail: { material: "pfm" } });
  mk("filling_amalgam", "25", { at: v1, status: "existing", surfaces: ["M", "O"] });
  mk("caries", "16", { at: v1, surfaces: ["M", "O"] });
  mk("filling_composite", "16", { at: v1, done: v2, surfaces: ["M", "O"], rec: P.lina, detail: {} });
  mk("rct", "26", { at: v1, done: v2, by: P.omar, detail: { canals: "3" } });
  mk("extraction", "46", { at: v1, done: v2, by: P.omar });
  mk("recession", "41", { at: v1 });

  // Visit 2 — the urgent work done.
  mk("scaling", "mouth", { at: v2, done: v2 });
  mk("night_guard", "upper", { at: v2, done: v2, by: P.omar, note: locale === "ar" ? "صرير ليلي" : "Night-time grinding" });
  mk("crown", "26", { at: v2, done: v3, by: P.omar, detail: { material: "zirconia" } });
  mk("filling_composite", "27", {
    at: v2,
    done: v2,
    surfaces: ["O"],
    rec: P.lina,
    voided: { at: v2, by: P.lina, reason: locale === "ar" ? "سُجّلت على السن الخطأ" : "Recorded on the wrong tooth" },
  });

  // Visit 3 — the next round planned.
  const bridge = "sample-bridge";
  mk("bridge", "13", { at: v3, groupId: bridge, role: "abutment", detail: { material: "zirconia" } });
  mk("bridge", "14", { at: v3, groupId: bridge, role: "pontic", detail: { material: "zirconia" } });
  mk("bridge", "15", { at: v3, groupId: bridge, role: "abutment", detail: { material: "zirconia" } });
  mk("implant", "46", { at: v3, by: P.omar });
  mk("caries", "36", { at: v3, surfaces: ["O", "D"] });
  mk("lesion", "36", { at: v3, by: P.omar });
  mk("rct", "36", { at: v3, by: P.omar, detail: { canals: "3" } });
  mk("mobility", "42", { at: v3, detail: { grade: "2" } });
  mk("xray_pa", "36", { at: v3, done: v3, rec: P.lina });
  mk("xray_bw", "Q1", { at: v3, done: v3, rec: P.lina });

  // Visit 4 — this month.
  mk("veneer", "11", { at: v4, detail: { material: "emax" } });
  mk("veneer", "21", { at: v4, detail: { material: "emax" } });
  mk("caries", "24", { at: v4, surfaces: ["D"] });
  mk("filling_composite", "24", { at: v4, surfaces: ["D"] });
  mk("fracture", "45", { at: v4 });
  mk("crown", "45", { at: v4, detail: { material: "emax" } });
  mk("srp", "Q3", { at: v4, by: P.omar });

  const favorites: Favorite[] = [
    { key: "filling_composite", addedBy: P.sara, addedAt: v1 },
    { key: "rct", addedBy: P.omar, addedAt: v1 },
    { key: "extraction", addedBy: P.omar, addedAt: v2 },
    { key: "crown", addedBy: P.sara, addedAt: v2 },
    { key: "scaling", addedBy: P.sara, addedAt: v3 },
    { key: "caries", addedBy: P.sara, addedAt: v3 },
  ];

  return { marks, events, favorites };
}
