import { DateTime } from "luxon";
import { dailyWindowOpen, rest, resting } from "./daily";
import { withSystem } from "./db";
import { hasFeature, licensed } from "./features";
import { startRun } from "./automations";
import { normalizeTriggerConfig } from "../src/lib/automation/catalog";
import { actionableToday, openTreatments, sessionLabel } from "../src/lib/courses";

/*
  The treatment coordinator's two daily passes (a test, behind the opt-in
  `coordinator` feature — see src/lib/courses.ts). Their own module, like
  treatments.ts: the scheduler reaches the WhatsApp session store, and the QA
  script that runs these passes would load Baileys. `force` skips the 10:00
  gate, for that script.
*/

/**
 * "The next session is due" — for each coordinator flow, the patients whose
 * next session falls within its `days_ahead`, by its `action` (book, or invite
 * for a dental plan). Once per patient per due date, so a booking that found
 * no free time, or an invitation nobody answered, is not tried every morning
 * after: reception has those, on the Treatments list.
 */
export async function treatmentSessionsDue(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone, cl.default_locale, cl.specialties
         from automations a join clinics cl on cl.id = a.clinic_id
        where a.active and a.trigger_type = 'treatment_session_due'
          and ${licensed("automations")} and ${hasFeature("coordinator")}`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (!opts.force && (!dailyWindowOpen(localNow, 10) || resting(`course:${auto.id}`))) continue;
      const cfg = normalizeTriggerConfig("treatment_session_due", auto.trigger_config);
      const action = cfg.action === "invite" ? "invite" : "book";
      const daysAhead = Number(cfg.days_ahead ?? 7);
      const locale = auto.default_locale === "en" ? "en" : "ar";
      // A psychiatry clinic's messages never name the treatment (a lock screen can be read by anyone).
      const discreet = ((auto.specialties ?? []) as string[]).includes("psychiatry");
      const open = await openTreatments(c, auto.clinic_id, { aheadDays: daysAhead });
      let started = 0;
      for (const t of open) {
        if (t.action !== action || !actionableToday(t, auto.timezone, daysAhead)) continue;
        const seen = await c.query(
          `select 1 from automation_runs
            where automation_id = $1 and patient_id = $2 and context->'trigger'->>'dueOn' = $3 limit 1`,
          [auto.id, t.patientId, t.dueOn]
        );
        if (seen.rowCount) continue;
        const name = discreet ? "" : (locale === "en" ? t.name || t.nameAr : t.nameAr || t.name);
        const runId = await startRun(
          c,
          auto.clinic_id,
          auto.id,
          { patientId: t.patientId, appointmentId: t.lastAppointmentId ?? undefined },
          {
            payload: {
              dueOn: t.dueOn,
              source: t.source,
              serviceId: t.serviceId,
              doctorId: t.doctorId,
              treatment: { name, tooth: discreet ? "" : t.tooth, session_label: sessionLabel(t, locale) },
            },
          }
        );
        if (runId) {
          started++;
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [auto.clinic_id, JSON.stringify({ runId }), `course:${auto.id}:${t.patientId}:${t.dueOn}`]
          );
        }
      }
      if (!opts.force) rest(`course:${auto.id}`, started);
    }
  });
}

/**
 * "Asked, and did not book" — a thread that began this week, that the clinic
 * answered (a person or the AI), whose patient went quiet for the flow's hours
 * with nothing booked: a new number, or a file that is still a lead. Once per
 * thread, ever: one nudge is help, a second is chasing.
 */
export async function enquiriesNotBooked(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone
         from automations a join clinics cl on cl.id = a.clinic_id
        where a.active and a.trigger_type = 'enquiry_not_booked'
          and ${licensed("automations")} and ${hasFeature("coordinator")}`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (!opts.force && (!dailyWindowOpen(localNow, 10) || resting(`enquiry:${auto.id}`))) continue;
      const cfg = normalizeTriggerConfig("enquiry_not_booked", auto.trigger_config);
      const hours = Math.max(6, Math.min(168, Number(cfg.hours ?? 24)));
      const quiet = await c.query(
        `select cv.id, cv.patient_id
           from conversations cv
           left join patients p on p.id = cv.patient_id
          where cv.clinic_id = $1 and cv.status = 'open'
            and cv.last_message_direction = 'out'
            and cv.last_message_at <= now() - ($2::int * interval '1 hour')
            and cv.last_message_at > now() - interval '7 days'
            and (cv.patient_id is null or (p.status = 'lead' and p.merged_into is null and not p.automation_opt_out))
            and (select min(m.created_at) from messages m where m.conversation_id = cv.id) > now() - interval '7 days'
            and exists (select 1 from messages m where m.conversation_id = cv.id and m.direction = 'in')
            and exists (select 1 from messages m where m.conversation_id = cv.id and m.direction = 'out' and m.sender_kind in ('staff', 'ai'))
            and not exists (
              select 1 from appointments b where b.clinic_id = $1 and b.patient_id = cv.patient_id and b.status <> 'cancelled')
            and not exists (select 1 from automation_runs r where r.automation_id = $3 and r.conversation_id = cv.id)
          order by cv.last_message_at
          limit 100`,
        [auto.clinic_id, hours, auto.id]
      );
      let started = 0;
      for (const row of quiet.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, {
          patientId: row.patient_id ?? undefined,
          conversationId: row.id,
        });
        if (runId) {
          started++;
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [auto.clinic_id, JSON.stringify({ runId }), `enquiry:${auto.id}:${row.id}`]
          );
        }
      }
      if (!opts.force) rest(`enquiry:${auto.id}`, started);
    }
  });
}
