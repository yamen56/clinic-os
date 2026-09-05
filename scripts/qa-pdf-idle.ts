/**
 * Does the PDF renderer let Chromium go when it is not being used?
 *
 * This is a cost test, not a correctness one. The browser used to be launched
 * once and kept forever, so several hundred megabytes sat resident around the
 * clock to serve a handful of renders a day — on metered hosting, the single
 * largest line on the bill. Memory that is billed by the second has to be
 * released when idle, and a burst still has to reuse one browser rather than
 * launching per page.
 */
/*
  Set before the module is imported: the renderer reads its idle window once, at
  load. Production waits five minutes, which no test should sit through — and
  relying on the caller to export this made the suite pass by hand and fail
  inside qa-all, which is the wrong way round for a test to behave.
*/
process.env.PDF_BROWSER_IDLE_MS ||= "1500";
/*
  Likewise the render ceiling. Production retires a browser after two hundred
  renders; two is enough to prove the counter without doing two hundred of them.
*/
process.env.PDF_MAX_RENDERS ||= "2";

type Renderer = typeof import("../worker/pdf");
let pdf: Renderer;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const held = () => globalThis.__cosBrowser !== undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A page that needs no server: rendering it exercises Chromium, nothing else. */
const PAGE = "data:text/html,<h1>clinic</h1>";

async function main() {
  console.log("▶ pdf browser lifecycle");
  pdf = await import("../worker/pdf");

  const first = await pdf.renderUrlToPdf(PAGE);
  check(
    "a render produces a PDF",
    first.subarray(0, 5).toString("latin1") === "%PDF-",
    `${first.length} bytes`
  );
  check("and the browser is held afterwards, ready for the next one", held());

  // A second render inside the idle window must reuse it, not relaunch.
  const before = globalThis.__cosBrowser;
  const t0 = Date.now();
  await pdf.renderUrlToPdf(PAGE);
  const reuseMs = Date.now() - t0;
  check("a follow-up render reuses the same browser", globalThis.__cosBrowser === before);
  check("so it is fast", reuseMs < 8000, `${reuseMs}ms`);

  // Now let it go idle. The env override keeps the test quick.
  console.log(`  … waiting out the idle window (${process.env.PDF_BROWSER_IDLE_MS}ms)`);
  await wait(Number(process.env.PDF_BROWSER_IDLE_MS || 1500) + 2500);

  check("an idle browser is released rather than held for ever", !held());

  // And it comes back on demand.
  const again = await pdf.renderUrlToPdf(PAGE);
  check(
    "the next render relaunches and still works",
    again.subarray(0, 5).toString("latin1") === "%PDF-",
    `${again.length} bytes`
  );
  check("holding it once more", held());

  /* ======================================================= degradation */
  /*
    The other half of the lifecycle, and the one that actually broke things.

    A Chromium held for hours stops being able to open pages: every render fails
    with `Target crashed` while `isConnected()` still returns true, so the reuse
    check waves it straight through and nothing recovers until the process
    restarts. Invoicing and both signing suites go red together and it reads
    like a regression in the PDF code.
  */
  console.log("\n▶ surviving a degraded browser");

  check("a crashed target is recognised", pdf.isBrowserDead(new Error("Target crashed")));
  check("so is a closed browser", pdf.isBrowserDead(new Error("Browser has been closed")));
  /*
    And a slow page is not. Retrying a 30-second navigation timeout would make
    the caller wait sixty seconds for the same answer — the classification is
    the whole point of retrying at all.
  */
  check("a navigation timeout is not", !pdf.isBrowserDead(new Error("Timeout 30000ms exceeded")));
  check("nor is a missing element", !pdf.isBrowserDead(new Error("locator.click: no element")));

  let attempts = 0;
  const recovered = await pdf.withFreshRetry("test", async () => {
    attempts++;
    if (attempts === 1) throw new Error("browser.newPage: Target crashed");
    return "second time";
  });
  check("a crash is retried once on a fresh browser", recovered === "second time" && attempts === 2, `${attempts} attempt(s)`);

  let slowAttempts = 0;
  let threw = "";
  try {
    await pdf.withFreshRetry("test", async () => {
      slowAttempts++;
      throw new Error("Timeout 30000ms exceeded");
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    "a timeout is not retried, and is reported as itself",
    slowAttempts === 1 && /Timeout/.test(threw),
    `${slowAttempts} attempt(s)`
  );

  /*
    Retried once, not forever. A browser that crashes on every launch would
    otherwise spin, and the caller would wait for all of it.
  */
  let always = 0;
  try {
    await pdf.withFreshRetry("test", async () => {
      always++;
      throw new Error("Target crashed");
    });
  } catch {
    /* expected */
  }
  check("and only once", always === 2, `${always} attempt(s)`);

  /* ======================================================= recycling */
  console.log("\n▶ retiring a browser before it degrades");
  /*
    The handle is captured *after* a render, not before.

    Capturing first read `undefined` — the retry tests above had just discarded
    the browser — so the comparison was "undefined is not a browser", which is
    true whether or not anything recycles. Removing the recycler left this
    passing, which is how it was found.
  */
  // PDF_MAX_RENDERS is 2 for this run, set at the top before the import.
  await pdf.renderUrlToPdf(PAGE);
  const beforeRecycle = globalThis.__cosBrowser;
  check("a browser is in hand to compare against", beforeRecycle !== undefined);
  await pdf.renderUrlToPdf(PAGE);
  check("still the same one inside the limit", globalThis.__cosBrowser === beforeRecycle);
  await pdf.renderUrlToPdf(PAGE);
  check(
    "a busy browser is replaced on a render count",
    globalThis.__cosBrowser !== beforeRecycle,
    `max ${process.env.PDF_MAX_RENDERS}`
  );
  const afterRecycle = await pdf.renderUrlToPdf(PAGE);
  check(
    "and renders keep working across the swap",
    afterRecycle.subarray(0, 5).toString("latin1") === "%PDF-",
    `${afterRecycle.length} bytes`
  );

  // Leave nothing running.
  const b = await globalThis.__cosBrowser;
  await b?.close().catch(() => {});

  console.log(`\n  pdf lifecycle: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("QA FAILED:", (e as Error).message);
  process.exit(1);
});
