import { withSystem } from "./db";
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
  const whatsappReady = sessions.size > 0;
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
}

export function startStatusHeartbeat(): void {
  const beat = () =>
    publish().catch((e) => console.error("[worker status]", (e as Error).message));
  void beat();
  setInterval(beat, REFRESH_MS).unref?.();
}
