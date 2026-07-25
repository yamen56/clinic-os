/**
 * CLINIC OS worker: WhatsApp sessions (Baileys), outbound sender with safety
 * rails, job/automation runner, scheduler, and push delivery.
 * Long-running process — never deploy to serverless.
 */
try {
  process.loadEnvFile?.();
} catch {}

import { withSystem, pool } from "./db";
import { ensureSession, sessions } from "./wa/session";
import { startOutboundLoop } from "./outbound";
import { startHttpServer } from "./http";

async function resumeDesiredSessions() {
  const rows = await withSystem(async (c) => {
    const r = await c.query(`select clinic_id from whatsapp_sessions where desired`);
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
  startOutboundLoop();
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
