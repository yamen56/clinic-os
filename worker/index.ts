/**
 * CLINIC OS worker: WhatsApp sessions (Baileys), outbound sender with safety
 * rails, job/automation runner, scheduler, and push delivery.
 * Long-running process — never deploy to serverless.
 */
import "./env"; // must precede every other import — see worker/env.ts

import { pool } from "./db";
import { ensureSession, stopSession, sessions } from "./wa/session";
import {
  WORKER_ID,
  claimSessions,
  clearLogoutRequest,
  releaseAllLeases,
  releaseLease,
  renewAndRead,
  sessionBudget,
} from "./wa/leases";
import { startOutboundLoop } from "./outbound";
import { startHttpServer } from "./http";
import { startJobLoop } from "./jobs";
import { startScheduler } from "./scheduler";
import { startNotificationLoop } from "./notifications";
import { startCampaignLoop } from "./campaigns";
import { registerEsignJobs } from "./esign";
import { registerEinvoiceJobs } from "./einvoice";
import { startStatusHeartbeat } from "./status";

/**
 * The last restart this worker acted on, per clinic.
 *
 * `POST /sessions/:id/connect` cannot restart the socket itself any more — it
 * may well have landed on a worker that does not own the clinic — so it bumps
 * `restart_seq` and the owner notices here. Holding the applied value in
 * memory rather than writing it back keeps the request path to a single write
 * and means a worker that takes over a clinic starts it fresh, which is the
 * same thing a restart would have produced.
 */
const appliedRestart = new Map<string, string>();

/**
 * Bring this process's live sockets in line with what the database says it
 * owns: renew the leases it holds, drop what it should not be running, start
 * what it should, and take on more if it has room.
 *
 * This replaces `resumeDesiredSessions`, which connected every clinic marked
 * desired. That was correct for exactly one worker and catastrophic for two —
 * both would connect every number and trade `connectionReplaced` forever. See
 * migration 0054.
 */
let reconciling = false;

async function reconcileSessions() {
  // Ticks are close together and a slow database must not stack them up.
  if (reconciling || shuttingDown) return;
  reconciling = true;
  try {
    const local = [...sessions.entries()].map(([clinicId, s]) => ({
      clinicId,
      connected: s.connected,
    }));
    const rows = await renewAndRead(local);
    const byId = new Map(rows.map((r) => [r.clinicId, r]));

    // What this process is running but should not be.
    for (const { clinicId } of local) {
      const row = byId.get(clinicId);
      if (!row || !row.wanted) {
        /*
          Disconnected by the clinic, or the clinic is gone. `logout_requested`
          means the request reached a worker that did not hold this socket, so
          the unlink WhatsApp needs is still owed and this process is the one
          that can make it.
        */
        console.log(`[worker] stopping session ${clinicId} (no longer wanted)`);
        await stopSession(clinicId, { logout: row?.logoutRequested });
        if (row?.logoutRequested) await clearLogoutRequest(clinicId).catch(() => {});
        appliedRestart.delete(clinicId);
        await releaseLease(clinicId).catch(() => {});
        continue;
      }
      if (row.ownerId !== WORKER_ID) {
        /*
          Another worker holds the lease, which means this one stalled long
          enough to be declared dead. Two live sockets on one number is the
          exact failure the lease exists to prevent, and the other worker is
          the one WhatsApp now considers current — so this side yields.
        */
        console.log(`[worker] yielding session ${clinicId} to ${row.ownerId}`);
        await stopSession(clinicId);
        appliedRestart.delete(clinicId);
        continue;
      }
      if (appliedRestart.get(clinicId) !== row.restartSeq) {
        console.log(`[worker] restarting session ${clinicId}`);
        await stopSession(clinicId);
        appliedRestart.set(clinicId, row.restartSeq);
        void ensureSession(clinicId);
      }
    }

    // What it owns and is not running — after a claim, or after a crash.
    for (const row of rows) {
      if (!row.wanted || row.ownerId !== WORKER_ID || sessions.has(row.clinicId)) continue;
      console.log(`[worker] resuming session ${row.clinicId}`);
      appliedRestart.set(row.clinicId, row.restartSeq);
      void ensureSession(row.clinicId);
    }

    // Clinics nobody is running. Taking them is what makes a second worker
    // useful, and what picks up a dead one's clinics.
    const unowned = rows.filter((r) => r.wanted && r.ownerId === null);
    if (unowned.length) {
      const taken = await claimSessions(Math.min(unowned.length, sessionBudget(sessions.size)));
      for (const clinicId of taken) {
        if (sessions.has(clinicId)) continue;
        console.log(`[worker] claimed session ${clinicId}`);
        appliedRestart.set(clinicId, byId.get(clinicId)?.restartSeq ?? "0");
        void ensureSession(clinicId);
      }
    }
  } finally {
    reconciling = false;
  }
}

/**
 * Fast, because a receptionist is watching for a QR code.
 *
 * The old loop ran every fifteen seconds and could afford to: the worker that
 * received the connect request was the worker that acted on it, so the poll
 * only ever caught up after a restart. Now the request is a row and the owner
 * finds it here, so this interval *is* the response time of the connect
 * button. One small query every three seconds buys that back.
 */
const RECONCILE_MS = Number(process.env.WA_RECONCILE_MS || 3000);

async function main() {
  console.log(`[worker] starting (id ${WORKER_ID})`);
  startHttpServer();
  await reconcileSessions().catch((e) =>
    console.error("[worker] reconcile failed:", (e as Error).message)
  );
  setInterval(
    () =>
      void reconcileSessions().catch((e) =>
        console.error("[worker] reconcile failed:", (e as Error).message)
      ),
    RECONCILE_MS
  );
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
    /*
      Hand the clinics back before the connection closes. Without this they
      stay unclaimable for the whole lease window — forty-five seconds of
      nobody's WhatsApp, at the one moment the replacement container is already
      up and asking for work. The sockets are down by now either way, so this
      only shortens the gap; if it fails, the stale-lease path still recovers.
    */
    .then(() => releaseAllLeases().catch(() => {}))
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
