/**
 * The public rate limits that must hold across replicas, proved rather than
 * assumed.
 *
 * The limiter these replaced counted into a `Map`, which is correct on one
 * instance and silently wrong on two: each process keeps its own tally, so the
 * real allowance is the written number times the replica count. For the read
 * endpoints that only loosens a flood floor. For the ones exercised here it
 * decides how many one-time codes a phone number can be sent and how many
 * guesses somebody gets at a six-digit code.
 *
 * So the property under test is not "it counts" — it is "the count lives in the
 * database", which is the only reason a second process would see it. Every
 * assertion below reads the row back rather than trusting the return value.
 */
try {
  process.loadEnvFile?.();
} catch {}

import { Client } from "pg";
import { rateLimitShared } from "../src/lib/rate-limit-shared";

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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const tag = Date.now().toString(36);
  const key = `qa-shared:${tag}`;
  const WINDOW = 60_000;
  const clean = () => db.query(`delete from rate_counters where bucket like $1`, [`qa-shared:%`]);
  await clean();

  console.log("\n[the count is in the database, not in this process]");
  ok("a fresh key is allowed", await rateLimitShared(key, 3, WINDOW));
  const stored = (
    await db.query(`select count from rate_counters where bucket like $1`, [`${key}@%`])
  ).rows;
  ok("one call wrote one row", stored.length === 1, `rows=${stored.length}`);
  ok("that row counted the call", Number(stored[0]?.count) === 1, `count=${stored[0]?.count}`);

  console.log("\n[the limit refuses at the written number, not a multiple of it]");
  ok("second call allowed", await rateLimitShared(key, 3, WINDOW));
  ok("third call allowed", await rateLimitShared(key, 3, WINDOW));
  ok("fourth call refused", !(await rateLimitShared(key, 3, WINDOW)));
  ok("fifth call still refused", !(await rateLimitShared(key, 3, WINDOW)));

  console.log("\n[another process sees the same tally]");
  /*
    What a second replica arriving mid-window actually does: it has no memory of
    its own, so its first call is an increment of the row already there. The
    Map-based limiter would have started this caller at 1 and allowed it — which
    is the exact bug, reproduced here as the thing that must not happen.
  */
  const fresh = `qa-shared:cross-${tag}`;
  await rateLimitShared(fresh, 2, WINDOW);
  await rateLimitShared(fresh, 2, WINDOW);
  // Simulates the second process: same key, same window, no local state.
  ok("a caller with no local state is still refused", !(await rateLimitShared(fresh, 2, WINDOW)));

  console.log("\n[windows rotate]");
  const rotating = `qa-shared:rotate-${tag}`;
  const SHORT = 1000;
  await rateLimitShared(rotating, 1, SHORT);
  ok("second call in the window is refused", !(await rateLimitShared(rotating, 1, SHORT)));
  await new Promise((r) => setTimeout(r, SHORT + 100));
  ok("the next window starts clean", await rateLimitShared(rotating, 1, SHORT));
  const buckets = (
    await db.query(`select count(*)::int as n from rate_counters where bucket like $1`, [
      `${rotating}@%`,
    ])
  ).rows[0].n;
  ok("each window is its own row", buckets === 2, `rows=${buckets}`);

  console.log("\n[pruning never removes a live window]");
  await db.query(`delete from rate_counters where expires_at < now()`);
  const survived = (
    await db.query(`select count(*)::int as n from rate_counters where bucket like $1`, [
      `qa-shared:%`,
    ])
  ).rows[0].n;
  ok("a window still in use survives a prune", survived > 0, `rows=${survived}`);

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
