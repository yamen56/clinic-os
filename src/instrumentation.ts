/**
 * Runs once when the web server process starts.
 *
 * The only thing here is the watchdog on the worker, and it lives in this
 * service for a reason that is not architectural neatness: **the worker cannot
 * report its own death.** Every other alarm in the platform runs inside it, so
 * when it crash-looped for a day on 2026-09-05 nothing said so, and the first
 * anyone knew was a message from Railway.
 *
 * The two services now watch each other. The worker checks the web app on its
 * five-minute pass; this checks the worker. The only failure neither can report
 * is both dying at once, which is what the GitHub Actions probe is for — and
 * that one is deliberately the *outer* net rather than the first line, because
 * measurement showed its five-minute schedule actually delivering runs four and a half
 * hours apart.
 */
export async function register() {
  /*
    Node only. Next also loads this file in the Edge runtime, where there is no
    `pg` and no timers worth keeping, and importing the alerting there would
    fail the build.
  */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  /*
    Not during `next build`. The build runs this file to collect metadata, and
    starting a database timer there would have the build machine emailing about
    a worker it has no business knowing exists.
  */
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const everyMs = Math.max(60_000, Number(process.env.WATCHDOG_INTERVAL_MS) || 5 * 60_000);
  const { runWatchdog } = await import("@/lib/ops-alert");

  /*
    Deliberately not on boot. A deploy restarts both services at once, and the
    worker takes a moment to come up — checking immediately would report it dead
    every single time anything shipped, which is precisely the crying-wolf that
    gets an alerter muted.
  */
  const timer = setInterval(() => {
    void runWatchdog();
  }, everyMs);
  // Never hold the process open on the watchdog's account.
  timer.unref?.();

  console.log(`[web] worker watchdog every ${Math.round(everyMs / 1000)}s`);
}
