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
