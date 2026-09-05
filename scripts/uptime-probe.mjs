/**
 * Is Clinicti healthy, asked from outside it?
 *
 * Every other alarm in this system runs *inside* the platform it watches. The
 * worker emails when the database or the web app is unwell — and nothing
 * reports the worker, because the worker is what sends the email. On
 * 2026-09-05 it crash-looped for a day and the first anyone knew was a message
 * from Railway.
 *
 * So this runs on GitHub's infrastructure (.github/workflows/uptime.yml), where
 * it survives the whole of Railway being down. It needs no credential:
 * `/api/health` is deliberately unauthenticated and deliberately carries
 * nothing worth reading.
 *
 * Kept as a script rather than inline YAML for one reason — it can be run here:
 *
 *   node scripts/uptime-probe.mjs
 *   node scripts/uptime-probe.mjs http://localhost:3000/api/health
 *
 * A monitor whose logic has never been executed before it was relied upon is
 * the same mistake as a backup nobody has restored.
 */
const URL_ = process.argv[2] || "https://app.clinicti.app/api/health";
const ATTEMPTS = 3;

/**
 * Three tries before crying wolf.
 *
 * A single failed request is somebody else's network as often as it is an
 * outage, and an alarm that cries wolf gets muted — which would leave us
 * exactly where this started.
 */
async function probe() {
  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(URL_, {
        signal: AbortSignal.timeout(20_000),
        headers: { "cache-control": "no-cache" },
      });
      const text = await res.text();
      last = `HTTP ${res.status} ${text.slice(0, 300)}`;

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        console.log(`attempt ${attempt}: response was not JSON`);
        body = null;
      }

      if (res.ok && body?.ok === true && body?.db?.ok === true && body?.worker?.ok !== false) {
        const idle = body.worker?.idleMs ?? "?";
        console.log(
          `healthy — db ${body.db.ms}ms, worker ${body.worker?.ok} (idle ${idle}ms), route ${body.route}`
        );
        /*
          Serving, but not the way it should be. Worth a warning annotation
          rather than a failure: the platform is up, and somebody should know
          the pooler is being bypassed before they find out some other way.
        */
        if (body.route === "fallback") {
          console.log("::warning::serving via the direct database route — the pooler is down");
        }
        // Unknown is not failure: a fresh environment has no heartbeat row yet.
        if (body.worker?.ok === null) {
          console.log("::warning::the worker has never reported in — no heartbeat row");
        }
        return 0;
      }
      console.log(`attempt ${attempt}: unhealthy — ${last}`);
    } catch (e) {
      last = e.message;
      console.log(`attempt ${attempt}: ${e.message}`);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 20_000));
  }

  console.log("::error::Clinicti is not healthy — check `npm run logs`");
  console.log(`Last response: ${last || "<none>"}`);
  return 1;
}

/*
  `process.exitCode` and a natural exit, never `process.exit()`.

  `AbortSignal.timeout` leaves a live timer behind, and forcing the process down
  on top of one trips a libuv assertion that exits 127 — a *failure* code on a
  perfectly healthy platform. Shipped like that, this monitor would have cried
  wolf every five minutes until somebody muted it, which is precisely the
  failure it exists to prevent. Caught by running it before trusting it.
*/
process.exitCode = await probe();
