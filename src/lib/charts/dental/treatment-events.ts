import type { PoolClient } from "pg";
import { findTreatment } from "./catalog";
import { isToothSite } from "./state";

/*
  What the automations know about a dental treatment (2026-11-03): whether a
  flow's trigger is about it, and what its messages can say about it. Shared
  by the worker's two dental triggers — a treatment finished, and a treatment
  under way whose next visit nobody booked — so they read a treatment the
  same way. Nothing here touches React or the web app: the worker image
  carries src/lib and no more.
*/

/** Whether a trigger narrowed to some categories or treatments is about this one. Empty lists mean any. */
export function treatmentFits(cfg: Record<string, unknown>, treatmentKey: string): boolean {
  const list = (k: string) => (Array.isArray(cfg[k]) ? (cfg[k] as string[]) : []);
  const keys = list("treatments");
  const cats = list("categories");
  if (keys.length && !keys.includes(treatmentKey)) return false;
  if (cats.length) {
    const category = findTreatment(treatmentKey, [])?.category;
    if (!category || !cats.includes(category)) return false;
  }
  return true;
}

/** A treatment's name as the patient reads it: the clinic's language, English where there is no Arabic. */
export const treatmentName = (row: { label: string; label_ar: string | null }, locale: string) =>
  (locale !== "en" ? row.label_ar : null) || row.label;

/**
 * The finished treatment behind a treatment_done event, or null when there is
 * no longer one: taken back in the chart's undo, voided, or reopened in the
 * two and a half minutes the event waited. Every tooth that had the same
 * treatment that day is named — three teeth out at one visit.
 */
export async function finishedTreatment(
  c: PoolClient,
  clinicId: string,
  markId: unknown
): Promise<{ treatmentKey: string; patientId: string; treatment: Record<string, string> } | null> {
  if (typeof markId !== "string") return null;
  const m = (
    await c.query(
      `select m.patient_id, m.treatment_key, m.label, m.label_ar, m.status, m.voided_at, cl.default_locale, cl.timezone
         from chart_marks m join clinics cl on cl.id = m.clinic_id
        where m.id = $1 and m.clinic_id = $2`,
      [markId, clinicId]
    )
  ).rows[0];
  if (!m || m.voided_at || m.status !== "done") return null;
  const teeth = await c.query(
    `select distinct site from chart_marks
      where clinic_id = $1 and patient_id = $2 and treatment_key = $3 and status = 'done' and voided_at is null
        and (done_at at time zone $4)::date = (now() at time zone $4)::date
      order by site`,
    [clinicId, m.patient_id, m.treatment_key, m.timezone]
  );
  return {
    treatmentKey: m.treatment_key,
    patientId: m.patient_id,
    treatment: {
      name: treatmentName(m, m.default_locale),
      tooth: teeth.rows.map((r) => r.site as string).filter(isToothSite).join(", "),
    },
  };
}
