import { withSystem } from "./db";
import { WORKER_ID } from "./wa/leases";
import { sessions } from "./wa/session";

/**
 * The worker publishing what it can do.
 *
 * The web app cannot read this process's environment, and for a while it tried
 * to guess: the AI settings screen tested its *own* ANTHROPIC_API_KEY, found
 * none — because the web service has no reason to hold one — and told the clinic
 * the agent was unconfigured while the worker was busy answering patients with
 * it. A row in the database is the only thing both sides can see.
 *
 * `updated_at` is the heartbeat. A worker that has stopped leaves a stale row
 * rather than a wrong one, so "the agent cannot run" and "nothing is running at
 * all" stay distinguishable.
 */

const REFRESH_MS = 60_000;

async function publish(): Promise<void> {
  const aiReady = !!process.env.ANTHROPIC_API_KEY;
  /*
    Asked of the fleet, not of this process.

    `sessions.size > 0` was the same question while one worker held every
    clinic. Once they are divided by lease, a worker carrying none of them —
    perfectly normal for a replica that has just started, or one that only
    drains jobs — would publish "WhatsApp not ready" over the top of a
    colleague that is running twenty clinics, and the settings screen would
    tell those clinics their messaging is down.
  */
  const whatsappReady = (
    await withSystem((c) =>
      c.query(`select exists (select 1 from whatsapp_sessions where status = 'connected') as up`)
    )
  ).rows[0].up as boolean;
  // Upsert, because the row is deliberately not seeded — see the migration.
  await withSystem((c) =>
    c.query(
      `insert into worker_status (id, ai_ready, whatsapp_ready, version, updated_at)
       values (true, $1, $2, $3, now())
       on conflict (id) do update
         set ai_ready = excluded.ai_ready,
             whatsapp_ready = excluded.whatsapp_ready,
             version = excluded.version,
             updated_at = now()`,
      [aiReady, whatsappReady, process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? ""]
    )
  );
  await publishInstance();
}

/**
 * What *this* process is carrying, as opposed to what the fleet can do.
 *
 * DEPLOY.md has carried "60–100 clinics per worker" with the honest note that
 * the number is unmeasured — an estimate about one process's memory. That is
 * the worst shape a ceiling can have: too low and a worker gets added that was
 * not needed, too high and the first anyone hears is a container hitting its
 * memory limit with every clinic's WhatsApp socket inside it, which costs a QR
 * rescan per clinic to recover from.
 *
 * One Baileys socket holds auth state, a store and a live WebSocket, so the
 * cost per clinic is real and perfectly measurable. It was only ever missing
 * because nobody wrote it down. Two numbers and a count, once a minute, and the
 * ceiling becomes something /admin/monitoring can show and ops-alert can warn
 * about before it is reached.
 */
async function publishInstance(): Promise<void> {
  const mem = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  await withSystem(async (c) => {
    await c.query(
      `insert into worker_instances
         (worker_id, sessions, rss_mb, heap_mb, version, started_at, updated_at)
       values ($1, $2, $3, $4, $5, now() - ($6 || ' seconds')::interval, now())
       on conflict (worker_id) do update
         set sessions = excluded.sessions,
             rss_mb = excluded.rss_mb,
             heap_mb = excluded.heap_mb,
             version = excluded.version,
             -- Deliberately not touched: a restart produces a new WORKER_ID on
             -- Railway, so a row that keeps being updated is the same process,
             -- and its start time is how long it has been holding this much.
             updated_at = now()`,
      [
        WORKER_ID,
        sessions.size,
        mb(mem.rss),
        mb(mem.heapUsed),
        process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? "",
        Math.round(process.uptime()),
      ]
    );
    /*
      Forget workers nobody has heard from in an hour. A container that is gone
      is gone — Railway will not reuse its replica id — and a table of ghosts
      makes "how many workers are there" unanswerable, which is the one question
      this exists to answer.
    */
    await c.query(`delete from worker_instances where updated_at < now() - interval '1 hour'`);
  });
}

export function startStatusHeartbeat(): void {
  const beat = () =>
    publish().catch((e) => console.error("[worker status]", (e as Error).message));
  void beat();
  setInterval(beat, REFRESH_MS).unref?.();
}
