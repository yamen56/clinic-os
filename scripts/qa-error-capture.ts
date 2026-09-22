/**
 * The application error log, proved rather than assumed.
 *
 * The property that matters is not "it writes a row" — it is that the row is
 * *grouped*, so a fault that fires ten thousand times is one thing to look at
 * rather than ten thousand, and that recording an error can never itself take
 * the platform down. Both are tested here, because both fail silently and both
 * fail exactly when the system is already having a bad day.
 */
try {
  process.loadEnvFile?.();
} catch {}

import { Client } from "pg";
import { captureError, resetCaptureThrottle } from "../src/lib/error-capture";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ok  ${n}`);
  } else {
    fails.push(`${n} — ${d}`);
    console.log(`  FAIL ${n} ${d}`);
  }
};

const ROUTE = "/qa/error-capture";

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const clean = () => db.query(`delete from app_errors where route like '/qa/%'`);
  await clean();
  resetCaptureThrottle();

  const rows = async () =>
    (await db.query(`select * from app_errors where route = $1 order by last_seen desc`, [ROUTE]))
      .rows;

  console.log("\n[an error becomes a row]");
  await captureError(new Error("the invoice would not total"), { route: ROUTE, kind: "action" });
  let r = await rows();
  ok("one error wrote one row", r.length === 1, `rows=${r.length}`);
  ok("the message is kept", r[0]?.message === "the invoice would not total");
  ok("the kind is kept", r[0]?.kind === "action", `kind=${r[0]?.kind}`);
  ok("a stack was captured", typeof r[0]?.stack === "string" && r[0].stack.length > 0);
  ok("it starts at one", Number(r[0]?.count) === 1, `count=${r[0]?.count}`);

  console.log("\n[the same fault groups instead of piling up]");
  for (let i = 0; i < 5; i++) {
    await captureError(new Error("the invoice would not total"), { route: ROUTE, kind: "action" });
  }
  r = await rows();
  ok("still one row after six occurrences", r.length === 1, `rows=${r.length}`);
  ok("the count carries the volume", Number(r[0]?.count) === 6, `count=${r[0]?.count}`);

  console.log("\n[ids do not split one fault into many]");
  await clean();
  resetCaptureThrottle();
  await captureError(new Error("patient 6f1e7a32-1b4c-4a71-9f2e-0d3c8b5a7e11 not found"), {
    route: ROUTE,
  });
  await captureError(new Error("patient 11112222-3333-4444-5555-666677778888 not found"), {
    route: ROUTE,
  });
  await captureError(new Error("patient 99990000-aaaa-bbbb-cccc-ddddeeeeffff not found"), {
    route: ROUTE,
  });
  r = await rows();
  ok("three patients, one bug, one row", r.length === 1, `rows=${r.length}`);
  ok("counted all three", Number(r[0]?.count) === 3, `count=${r[0]?.count}`);

  console.log("\n[different faults stay apart]");
  await captureError(new Error("something else entirely"), { route: ROUTE });
  r = await rows();
  ok("a distinct message is a distinct row", r.length === 2, `rows=${r.length}`);

  console.log("\n[a route pattern is never a filled-in path]");
  await clean();
  resetCaptureThrottle();
  await captureError(new Error("same fault"), { route: "/qa/c/[slug]/x" });
  await captureError(new Error("same fault"), { route: "/qa/c/[slug]/x" });
  const grouped = (
    await db.query(`select count(*)::int as n from app_errors where route = '/qa/c/[slug]/x'`)
  ).rows[0].n;
  ok("one row for the pattern", grouped === 1, `rows=${grouped}`);

  console.log("\n[a fault that comes back reopens]");
  await db.query(`update app_errors set resolved_at = now() where route = '/qa/c/[slug]/x'`);
  await captureError(new Error("same fault"), { route: "/qa/c/[slug]/x" });
  const reopened = (
    await db.query(
      `select resolved_at from app_errors where route = '/qa/c/[slug]/x'`
    )
  ).rows[0];
  ok("marking it done does not hide the next one", reopened?.resolved_at === null);

  console.log("\n[recording can never take the platform down]");
  await clean();
  resetCaptureThrottle();
  /*
    The amplification case: when the database goes, every request throws, and if
    each throw wrote a row the recording would spend a pool connection per
    failure at the moment connections are scarcest. The cap is what stops it.
  */
  for (let i = 0; i < 40; i++) {
    await captureError(new Error(`flood ${i}`), { route: ROUTE });
  }
  const written = (
    await db.query(`select count(*)::int as n from app_errors where route = $1`, [ROUTE])
  ).rows[0].n;
  ok("the per-minute cap holds", written <= 30, `rows=${written}`);
  ok("and it still recorded something", written > 0, `rows=${written}`);

  console.log("\n[a broken logger is not a broken request]");
  // A value that is not an Error at all — the shape a `throw "string"` produces.
  let threw = false;
  try {
    await captureError("just a string", { route: ROUTE });
  } catch {
    threw = true;
  }
  ok("capturing a non-Error does not throw", !threw);

  await clean();
  await db.end();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
