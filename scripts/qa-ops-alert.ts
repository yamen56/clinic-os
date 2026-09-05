/**
 * Does anybody find out when the platform breaks?
 *
 * For most of this product's life the answer was no. Every notification path
 * points at a clinic; none pointed at the operator. The nightly backup stopped
 * and five weeks passed with every screen green.
 *
 * The first check in this file is the important one, and it is not about email.
 * It asserts that **every scheduled job is actually registered in the tick
 * list**, because the replacement for that silent backup failure was a
 * `backupHealth()` function that was written, reviewed, described in a commit
 * message as "registered in the tick list" — and never added to the array. It
 * had not run once. A safeguard that exists in the source and does nothing at
 * runtime is the exact bug the safeguard was written to prevent, and it has now
 * happened twice in the same file, so it gets a rule instead of more care.
 *
 *   npx tsx scripts/qa-ops-alert.ts
 */
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import { reconcile, heartbeat, collectFindings, type Finding } from "../src/lib/ops-alert";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const K1 = "qa_test_alpha";
const K2 = "qa_test_beta";

function finding(key: string, title = "test condition"): Finding {
  return { key, title, detail: "raised by qa-ops-alert" };
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const clean = () =>
    db.query(`delete from ops_alerts where key like 'qa_test_%'`);
  await clean();

  /* ================================================= the registration rule */
  console.log("\n[every scheduled job is actually scheduled]");
  const src = fs.readFileSync(path.join("worker", "scheduler.ts"), "utf8");
  const tickBlock = /for \(const fn of \[([\s\S]*?)\]\)/.exec(src);
  check("the tick list was found", !!tickBlock);
  const registered = new Set(
    (tickBlock?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  /*
    Every module-level `async function` in the scheduler is a job unless it is
    plainly a helper. The exceptions are named, so adding one is a decision
    somebody has to write down rather than an omission nobody notices.
  */
  const HELPERS = new Set(["startScheduler"]);
  const declared = [...src.matchAll(/^async function (\w+)\s*\(/gm)].map((m) => m[1]);
  check("scheduler jobs were found", declared.length > 5, `${declared.length}`);
  const orphans = declared.filter((n) => !HELPERS.has(n) && !registered.has(n));
  check(
    "no job is defined but never run",
    orphans.length === 0,
    orphans.length ? `orphaned: ${orphans.join(", ")}` : `${registered.size} registered`
  );
  check("opsHealth in particular is registered", registered.has("opsHealth"));

  /*
    The same rule applied to the check list inside ops-alert itself, which is an
    array of functions with exactly the same hazard: a probe can be written,
    reviewed and merged without ever being added to it, and nothing at all would
    say so. `collectFindings` catches a probe that *throws*; it cannot notice one
    that is never called.
  */
  const ops = fs.readFileSync(path.join("src", "lib", "ops-alert.ts"), "utf8");
  const listed = /const checks: \(\(\) => Promise<Finding\[\]>\)\[\] = \[([\s\S]*?)\]/.exec(ops);
  check("the check list was found", !!listed);
  const inList = new Set(
    (listed?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  const probes = [...ops.matchAll(/^async function (\w*Checks)\s*\(/gm)].map((m) => m[1]);
  check("probes were found", probes.length >= 5, `${probes.length}`);
  const unlisted = probes.filter((p) => !inList.has(p));
  check(
    "every probe is in the check list",
    unlisted.length === 0,
    unlisted.length ? `never called: ${unlisted.join(", ")}` : `${inList.size} listed`
  );

  /* ================================================= open / renotify / resolve */
  console.log("\n[an alert opens once, not once a minute]");
  const first = await reconcile([finding(K1)]);
  check("a new condition opens", first.opened.includes(K1));
  const again = await reconcile([finding(K1)]);
  check("the same condition does not open twice", again.opened.length === 0);
  check("and is not re-notified immediately", again.renotified.length === 0);
  const rows = await db.query(`select notifications from ops_alerts where key = $1`, [K1]);
  check("one row, one notification", rows.rows[0]?.notifications === 1, String(rows.rows[0]?.notifications));

  console.log("\n[being ignored is escalated, slowly]");
  // Age the row past the six-hour re-notify window rather than waiting for it.
  await db.query(
    `update ops_alerts set last_notified = now() - interval '7 hours' where key = $1`,
    [K1]
  );
  const third = await reconcile([finding(K1)]);
  check("a persisting condition is raised again", third.renotified.includes(K1));
  const after = await db.query(`select notifications from ops_alerts where key = $1`, [K1]);
  check("and the count rises", after.rows[0]?.notifications === 2, String(after.rows[0]?.notifications));

  console.log("\n[clearing is reported too]");
  const cleared = await reconcile([]);
  check("a condition that stops being true resolves", cleared.resolved.includes(K1));
  const gone = await db.query(`select 1 from ops_alerts where key = $1`, [K1]);
  check("and its row is removed", gone.rowCount === 0);
  const quiet = await reconcile([]);
  check("nothing is said when nothing is wrong", quiet.opened.length + quiet.resolved.length === 0);

  console.log("\n[two problems are two alerts]");
  const both = await reconcile([finding(K1), finding(K2)]);
  check("both open", both.opened.length === 2, both.opened.join(", "));
  const oneLeft = await reconcile([finding(K2)]);
  check("resolving one leaves the other", oneLeft.resolved.length === 1 && oneLeft.resolved[0] === K1);
  const stillOpen = await db.query(`select key from ops_alerts where key like 'qa_test_%'`);
  check("exactly one remains", stillOpen.rowCount === 1 && stillOpen.rows[0].key === K2);
  await reconcile([]);

  /* ================================================= the checker's own health */
  console.log("\n[a broken probe reports itself instead of hiding]");
  const findings = await collectFindings();
  check(
    "collecting never throws",
    Array.isArray(findings),
    `${findings.length} finding(s): ${findings.map((f) => f.key).join(", ") || "none"}`
  );
  /*
    Every finding must carry a title and a detail. An alert that arrives saying
    only "something is wrong" costs the reader the same investigation as no
    alert, and this is the cheapest place to insist on that.
  */
  check(
    "every finding says what and why",
    findings.every((f) => f.key && f.title.length > 8 && f.detail.length > 8),
    findings.map((f) => f.key).join(", ")
  );

  /* ================================================= the heartbeat */
  console.log("\n[silence has to mean something]");
  await db.query(`delete from ops_state where key = 'heartbeat_at'`);
  const firstBeat = await heartbeat(0);
  check("the very first run does not send an all-clear", firstBeat === false);
  const recorded = await db.query(`select value from ops_state where key = 'heartbeat_at'`);
  check("but it does start the clock", recorded.rowCount === 1);
  const tooSoon = await heartbeat(0);
  check("and does not send again straight away", tooSoon === false);
  await db.query(
    `update ops_state set value = $1 where key = 'heartbeat_at'`,
    [String(Date.now() - 8 * 24 * 3600_000)]
  );
  const due = await heartbeat(0);
  check("a week later the all-clear goes out", due === true);

  await db.query(`delete from ops_state where key = 'heartbeat_at'`);
  await clean();
  await db.end();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
