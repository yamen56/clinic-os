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
import { registerEinvoiceJobs } from "./einvoice";
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
  registerEinvoiceJobs();
  startOutboundLoop();
  startCampaignLoop();
  startJobLoop();
  startScheduler();
  startNotificationLoop();
  // Last, so it advertises a worker that has finished starting up.
  startStatusHeartbeat();
  console.log("[worker] ready");
}

/**
 * A stray promise must not take every clinic's WhatsApp down with it.
 *
 * Node terminates the process on an unhandled rejection by default. In a
 * request-scoped server that is defensible; here it is not. This process holds
 * one live socket per clinic, and dropping all of them because a single
 * un-awaited promise rejected somewhere is wildly out of proportion to the
 * fault — a reconnect storm and a QR rescan, caused by a log line that never
 * got written.
 *
 * So: log it loudly and keep serving. The rejection is a bug to fix, and it is
 * now visible (`npm run logs`) rather than being a container that vanished for
 * reasons nobody recorded.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[worker] UNHANDLED REJECTION — staying up:", reason);
});

/**
 * An uncaught exception is different, and does exit.
 *
 * A rejected promise usually means one operation failed. An exception that
 * escaped every frame means the process is in a state nobody reasoned about,
 * and carrying on with a Baileys socket in unknown condition risks sending the
 * wrong thing to the wrong patient. Railway restarts it in seconds.
 *
 * The point is that it is *said* first. This process crash-looped for a day on
 * 2026-09-05 and the only record was a stack trace in a log nobody was reading.
 */
process.on("uncaughtException", (err) => {
  console.error("[worker] UNCAUGHT EXCEPTION — restarting:", err);
  process.exit(1);
});

/**
 * Putting the WhatsApp sockets down before the container goes.
 *
 * This used to listen for `SIGINT` only — which is Ctrl+C, and is not what
 * stops a container. Docker and Railway send **SIGTERM**, so on every deploy
 * and every restart the graceful path was skipped entirely and the process was
 * killed with its sockets still open. WhatsApp then saw the *new* container
 * connect while the old registration was still live, and answered with
 * `connectionReplaced` — the `closed (code 440)` in the logs after each deploy.
 *
 * Closing them properly is worth doing for its own sake: an unofficial client
 * that repeatedly vanishes and reappears is the behaviour that gets a number
 * looked at, and this happened on every single release.
 *
 * **Bounded, because a shutdown that hangs is a shutdown that gets SIGKILLed.**
 * The grace period is short — ten seconds by default — so sessions are stopped
 * in parallel against a deadline, and the process leaves on time regardless. A
 * socket closed slightly rudely is better than every socket closed rudely.
 */
const SHUTDOWN_BUDGET_MS = Number(process.env.SHUTDOWN_BUDGET_MS || 6000);
let shuttingDown = false;

async function shutdown(signal: string) {
  // A second signal must not start a second teardown over the top of the first.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} — closing ${sessions.size} session(s)`);

  const done = Promise.all([...sessions.values()].map((s) => s.stop().catch(() => {})))
    .then(() => pool.end().catch(() => {}))
    .then(() => "clean" as const);
  /*
    Not unref'd, unlike every other timer here. This one is supposed to hold the
    loop open for its few seconds — unref'd, Node could reach an idle event loop
    and exit before the race settles, skipping the line that says how the
    shutdown went. That line is the only evidence this ran at all.
  */
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), SHUTDOWN_BUDGET_MS));

  const how = await Promise.race([done, timeout]);
  console.log(`[worker] shutdown ${how}`);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
