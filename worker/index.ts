/**
 * CLINIC OS worker: WhatsApp sessions (Baileys), outbound sender with safety
 * rails, job/automation runner, scheduler, and push delivery.
 * Long-running process — never deploy to serverless.
 */
import "./env"; // must precede every other import — see worker/env.ts

import { withSystem, pool } from "./db";
import { ensureSession, sessions } from "./wa/session";
import { startOutboundLoop } from "./outbound";
import { startHttpServer } from "./http";
import { startJobLoop } from "./jobs";
import { startScheduler } from "./scheduler";
import { startNotificationLoop } from "./notifications";
import { startCampaignLoop } from "./campaigns";
import { registerEsignJobs } from "./esign";
import { startStatusHeartbeat } from "./status";

async function resumeDesiredSessions() {
  const rows = await withSystem(async (c) => {
    /*
      Joined to clinics so a deleted one is skipped. Deleting a clinic clears
      `desired` in the same transaction, but this loop runs every fifteen
      seconds against whatever the column says — and a session that reconnected
      from a stale row would put a closed clinic's number back online, sending
      on behalf of people who can no longer sign in to see it.
    */
    const r = await c.query(
      `select ws.clinic_id from whatsapp_sessions ws
         join clinics cl on cl.id = ws.clinic_id
        where ws.desired and cl.deleted_at is null`
    );
    return r.rows as { clinic_id: string }[];
  });
  for (const row of rows) {
    if (!sessions.has(row.clinic_id)) {
      console.log(`[worker] resuming session ${row.clinic_id}`);
      void ensureSession(row.clinic_id);
    }
  }
}

async function main() {
  console.log("[worker] starting");
  startHttpServer();
  await resumeDesiredSessions();
  // Catch sessions marked desired while the worker was down (or by another instance)
  setInterval(() => void resumeDesiredSessions().catch(() => {}), 15000);
  registerEsignJobs();
  startOutboundLoop();
  startCampaignLoop();
  startJobLoop();
  startScheduler();
  startNotificationLoop();
  // Last, so it advertises a worker that has finished starting up.
  startStatusHeartbeat();
  console.log("[worker] ready");
}

process.on("SIGINT", async () => {
  console.log("[worker] shutting down");
  for (const [, s] of sessions) await s.stop().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
});

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
