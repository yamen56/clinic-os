import { withSystem } from "./db";
import { advanceRun, handleTrigger } from "./automations";
import { respondToConversation } from "./ai/agent";
import { autoSendServiceDocuments } from "./esign";

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
