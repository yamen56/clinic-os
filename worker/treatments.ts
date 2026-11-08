import { DateTime } from "luxon";
import { dailyWindowOpen, rest, resting } from "./daily";
import { withSystem } from "./db";
import { licensed } from "./features";
import { startRun } from "./automations";
import { normalizeTriggerConfig } from "../src/lib/automation/catalog";
import { treatmentFits, treatmentName } from "../src/lib/charts/dental/treatment-events";
import { isToothSite } from "../src/lib/charts/dental/state";

/*
  Its own module, like expenses.ts: the scheduler reaches the WhatsApp session
  store, and a QA script that imports it to run this pass would load Baileys.
  `force` skips the 11:00 gate, for that script.
*/

/**
 * "A treatment under way, and its next visit not booked" (2026-11-03).
 *
 * A root canal, an implant, a crown is several visits, and the patient who
 * felt better after the first is the one who does not come back for the rest
 * — the root-filled tooth with no crown is the tooth that breaks. So: a
 * treatment started (a step recorded) and not finished, whose last step was
 * exactly N days ago (the clinic's own day), for a patient with nothing booked
 * from now on. Exactly N days, like the unpaid-invoice chase, so it fires once
 * per stall rather than every morning after.
 *
 * One run per patient, naming every treatment that stalled that day, so two
 * stalled treatments are one message, not two.
 */
export async function unbookedTreatments(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone, cl.default_locale from automations a
       join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'treatment_unbooked' and ${licensed("automations")}`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (!opts.force && (!dailyWindowOpen(localNow, 11) || resting(`unbooked:${auto.id}`))) continue;
      const cfg = normalizeTriggerConfig("treatment_unbooked", auto.trigger_config);
      const days = Number(cfg.days ?? 7);
      const stalled = await c.query(
        `select m.patient_id, m.treatment_key, m.label, m.label_ar, m.site
           from chart_marks m
           join lateral (
             select max(s.done_at) as at from chart_mark_steps s
              where s.mark_id = m.id and s.voided_at is null and s.step <> 'emergency'
           ) last on true
          where m.clinic_id = $1 and m.chart = 'dental' and m.kind = 'procedure'
            and m.status = 'planned' and m.voided_at is null
            and last.at is not null
            and (last.at at time zone $2)::date = (now() at time zone $2)::date - $3::int
            and not exists (
              select 1 from appointments a
               where a.patient_id = m.patient_id and a.clinic_id = m.clinic_id and a.starts_at > now()
                 and a.status in ('scheduled', 'confirmed', 'pending_approval'))
          order by m.patient_id, m.created_at
          limit 500`,
        [auto.clinic_id, auto.timezone, days]
      );
      const byPatient = new Map<string, { names: string[]; teeth: string[] }>();
      for (const r of stalled.rows) {
        if (!treatmentFits(cfg, r.treatment_key)) continue;
        const p = byPatient.get(r.patient_id) ?? { names: [], teeth: [] };
        const name = treatmentName(r, auto.default_locale);
        if (!p.names.includes(name)) p.names.push(name);
        if (isToothSite(r.site) && !p.teeth.includes(r.site)) p.teeth.push(r.site);
        byPatient.set(r.patient_id, p);
      }
      const sep = auto.default_locale === "en" ? ", " : "، ";
      let started = 0;
      for (const [patientId, p] of byPatient) {
        /*
          Once a day per patient. The 11:00 window is up to three ticks, and a
          run that has already finished (sent, notified) no longer holds the
          one-active-run guard — without this the reminder went three times.
        */
        const today = await c.query(
          `select 1 from automation_runs where automation_id = $1 and patient_id = $2 and started_at > now() - interval '20 hours' limit 1`,
          [auto.id, patientId]
        );
        if (today.rowCount) continue;
        const runId = await startRun(c, auto.clinic_id, auto.id, { patientId }, {
          payload: { treatment: { name: p.names.join(sep), tooth: p.teeth.join(", ") } },
        });
        if (runId) {
          started++;
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [auto.clinic_id, JSON.stringify({ runId }), `unbooked:${auto.id}:${patientId}:${localNow.toISODate()}`]
          );
        }
      }
      if (!opts.force) rest(`unbooked:${auto.id}`, started);
    }
  });
}
