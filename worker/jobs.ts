import { withSystem } from "./db";
import { advanceRun, handleTrigger } from "./automations";
import { respondToConversation } from "./ai/agent";
import { autoSendServiceDocuments } from "./esign";
import { offerFreedSlot, closeWaitlistOnBooking } from "./waitlist";

/**
 * Job runner: claims due jobs with FOR UPDATE SKIP LOCKED so multiple worker
 * instances never process the same job. Failures retry with exponential backoff.
 */

type JobHandler = (payload: Record<string, unknown>, clinicId: string | null) => Promise<void>;

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

async function claimJob() {
  return withSystem(async (c) => {
    const r = await c.query(
      `update jobs set status = 'running', attempts = attempts + 1, updated_at = now()
       where id = (
         select id from jobs where status = 'pending' and run_at <= now()
         order by run_at limit 1 for update skip locked
       )
       returning *`
    );
    return r.rows[0] ?? null;
  });
}

async function runOne(): Promise<boolean> {
  const job = await claimJob();
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
      await handler(job.payload ?? {}, job.clinic_id);
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

export function startJobLoop() {
  const tick = async () => {
    try {
      let worked = true;
      let budget = 20;
      while (worked && budget-- > 0) worked = await runOne();
    } catch (e) {
      console.error("[jobs]", (e as Error).message);
    }
    setTimeout(tick, 1000);
  };
  void tick();
}
