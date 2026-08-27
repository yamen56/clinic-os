import { withSystem } from "./db";
import { advanceRun, handleTrigger } from "./automations";
import { respondToConversation } from "./ai/agent";
import { autoSendServiceDocuments } from "./esign";
import { offerFreedSlot, closeWaitlistOnBooking } from "./waitlist";

/**
 * Job runner: claims due jobs with FOR UPDATE SKIP LOCKED so multiple worker
 * instances never process the same job. Failures retry with exponential backoff.
 */

/**
 * The third argument is how many goes this job has left.
 *
 * Almost every handler ignores it and should: throwing is the right way to fail,
 * and the runner below does the backoff. It exists for the handlers whose
 * failure has to be *reported* to somebody — filing an invoice with a tax
 * authority, say — which can only be done on the attempt that turns out to be
 * the last one. Optional, so the handlers that do not care stay two-argument
 * functions.
 */
export type JobAttempt = { attempts: number; maxAttempts: number; isLastAttempt: boolean };

type JobHandler = (
  payload: Record<string, unknown>,
  clinicId: string | null,
  attempt: JobAttempt
) => Promise<void>;

const handlers: Record<string, JobHandler> = {
  "automation:advance": async (payload) => {
    await advanceRun(String(payload.runId));
  },
  "ai:respond": async (payload) => {
    await respondToConversation(String(payload.conversationId));
  },
};

export function registerJobHandler(kind: string, fn: JobHandler) {
  handlers[kind] = fn;
}

/**
 * The kinds whose work happens on somebody else's server.
 *
 * Everything the runner does is fast — a few database statements, tens of
 * milliseconds — except these, which wait on a third party: Anthropic for a
 * reply, the tax authority for a stamp, our own Chromium for a PDF. Seconds
 * each, and until now they took the only lane with them. One clinic's busy
 * morning of AI conversations delayed every other clinic's appointment
 * reminders behind it, and nothing anywhere said so.
 *
 * They get their own loop. Both loops claim with FOR UPDATE SKIP LOCKED, which
 * is what makes two of them safe — it is the same mechanism that already let
 * two worker instances coexist.
 *
 * Matched by prefix so a new document or e-invoice job joins the slow lane by
 * being named like its siblings, rather than by somebody remembering to come
 * back here.
 */
const SLOW_PREFIXES = ["ai:", "einvoice:", "document:"] as const;

export function isSlowKind(kind: string): boolean {
  return SLOW_PREFIXES.some((p) => kind.startsWith(p));
}

/** SQL for "this job belongs to my lane", built from the same list. */
function laneFilter(slow: boolean): string {
  const tests = SLOW_PREFIXES.map((p) => `kind like '${p}%'`).join(" or ");
  return slow ? `(${tests})` : `not (${tests})`;
}

async function claimJob(slow: boolean) {
  return withSystem(async (c) => {
    const r = await c.query(
      `update jobs set status = 'running', attempts = attempts + 1, updated_at = now()
       where id = (
         select id from jobs
          where status = 'pending' and run_at <= now() and ${laneFilter(slow)}
          order by run_at limit 1 for update skip locked
       )
       returning *`
    );
    return r.rows[0] ?? null;
  });
}

async function runOne(slow: boolean): Promise<boolean> {
  const job = await claimJob(slow);
  if (!job) return false;

  try {
    if (job.kind.startsWith("trigger:")) {
      const kind = job.kind.slice("trigger:".length);
      if (!job.clinic_id) throw new Error("trigger job without clinic");
      await handleTrigger(kind, job.clinic_id, job.payload ?? {});

      /*
        A confirmed appointment also raises the consent forms its service
        requires. This sits outside the automation engine on purpose: the form is
        chosen by the booked service, which no single recipe could express.
      */
      if (
        kind === "appointment_status_changed" &&
        job.payload?.status === "confirmed" &&
        job.payload?.appointmentId
      ) {
        await autoSendServiceDocuments(job.clinic_id, String(job.payload.appointmentId));
      }

      /*
        A slot that just came free is offered to whoever is waiting for it.

        Outside the automation engine for the same reason as the consent forms
        above: the recipients are chosen by matching a waitlist against the
        freed slot's doctor, service and date, which no recipe can express.
      */
      if (
        kind === "appointment_status_changed" &&
        (job.payload?.status === "cancelled" || job.payload?.status === "no_show") &&
        job.payload?.appointmentId
      ) {
        const appt = await withSystem(async (c) =>
          (
            await c.query(
              `select id, doctor_member_id, service_id, starts_at from appointments
                where id = $1 and clinic_id = $2 and starts_at > now()`,
              [String(job.payload!.appointmentId), job.clinic_id]
            )
          ).rows[0]
        );
        // Only a future slot is worth offering; a no-show this morning frees
        // nothing anybody can still take.
        if (appt) {
          await offerFreedSlot({
            clinicId: job.clinic_id,
            appointmentId: appt.id as string,
            doctorMemberId: (appt.doctor_member_id as string) ?? null,
            serviceId: (appt.service_id as string) ?? null,
            startsAt: new Date(appt.starts_at as string).toISOString(),
          });
        }
      }

      // Booking is how a waitlist entry ends. Whether it came from an offer we
      // sent or a phone call, what they were waiting for has happened.
      if (kind === "appointment_created" && job.payload?.appointmentId) {
        await closeWaitlistOnBooking(job.clinic_id, String(job.payload.appointmentId));
      }

      // An inbound patient message also wakes the AI receptionist.
      if (kind === "inbound_message" && job.payload?.conversationId) {
        await withSystem((c) =>
          c.query(
            `insert into jobs (clinic_id, kind, payload, run_at) values ($1, 'ai:respond', $2, now() + interval '4 seconds')`,
            [job.clinic_id, JSON.stringify({ conversationId: job.payload.conversationId })]
          )
        );
      }
    } else {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      // `attempts` was already incremented by claimJob, so it counts this one.
      await handler(job.payload ?? {}, job.clinic_id, {
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        isLastAttempt: job.attempts >= job.max_attempts,
      });
    }
    await withSystem((c) =>
      c.query(`update jobs set status = 'done', last_error = null where id = $1`, [job.id])
    );
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    console.error(`[job ${job.kind}] failed:`, msg);
    await withSystem((c) =>
      c.query(
        `update jobs set
           status = case when attempts >= max_attempts then 'failed' else 'pending' end,
           run_at = now() + (least(attempts, 6) * interval '30 seconds'),
           last_error = $2
         where id = $1`,
        [job.id, msg]
      )
    );
  }
  return true;
}

/**
 * One lane. `budget` is how many jobs it may drain before yielding.
 *
 * The fast lane takes twenty, because twenty of its jobs is under a second. The
 * slow lane takes one: its jobs are seconds each, and draining twenty of them
 * back to back would just rebuild the queue this split exists to break up — on
 * a schedule, rather than by accident.
 */
function startLane(slow: boolean, budgetPerTick: number, everyMs: number) {
  const label = slow ? "jobs:slow" : "jobs";
  const tick = async () => {
    try {
      let worked = true;
      let budget = budgetPerTick;
      while (worked && budget-- > 0) worked = await runOne(slow);
    } catch (e) {
      console.error(`[${label}]`, (e as Error).message);
    }
    setTimeout(tick, everyMs);
  };
  void tick();
}

/**
 * How many slow jobs may be in flight at once.
 *
 * One is enough for a long way: a lane that spends ~6 seconds per job clears
 * around 14,000 a day, and 250 clinics holding thirty AI conversations each
 * comes to 7,500. Raising it multiplies the load we put on somebody else's
 * service — Anthropic, ISTD, and our own single Chromium, which renders PDFs
 * one at a time — so it is a number to raise deliberately after measuring, not
 * a default to be generous with.
 */
const SLOW_LANES = Math.max(1, Number(process.env.WORKER_SLOW_LANES || 1));

export function startJobLoop() {
  startLane(false, 20, 1000);
  for (let i = 0; i < SLOW_LANES; i++) startLane(true, 1, 1000);
}
