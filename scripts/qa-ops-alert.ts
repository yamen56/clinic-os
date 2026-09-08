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

/*
  Urgent by default so that the mechanical assertions below — opens once,
  re-notifies slowly, resolves — keep testing what they were written to test.
  Severity decides delivery, not bookkeeping, and the two are worth separating.
*/
function finding(
  key: string,
  title = "test condition",
  severity: Finding["severity"] = "urgent"
): Finding {
  return { key, title, detail: "raised by qa-ops-alert", severity };
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
  /*
    `export` is optional in this pattern and that is load-bearing. `whatsappChecks`
    is exported so qa can drive it directly, and a regex anchored on a bare
    `async function` would have stopped matching it — quietly dropping the one
    probe most worth watching out of the very check that exists to notice a probe
    going missing. Exporting a function must not be able to reduce coverage.
  */
  const probes = [...ops.matchAll(/^(?:export )?async function (\w*Checks)\s*\(/gm)].map(
    (m) => m[1]
  );
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

  /* ================================================= severity decides delivery */
  /*
    The rule that exists because of 6-8 September 2026: seventeen emails in
    fifty-five hours, every one a WhatsApp session reconnecting by itself. The
    dedupe was working; the condition was never worth sending. So a `notice` is
    recorded and shown on /admin/monitoring and never mailed, and the assertions
    below are about the *inbox*, not the table — `reconcile` reports which keys
    it actually delivered, so this can be tested without reading email.
  */
  console.log("\n[a notice is recorded, not sent]");
  const quietOpen = await reconcile([finding(K1, "a quiet condition", "notice")]);
  check("a notice still opens a row", quietOpen.opened.includes(K1));
  check("but nothing is emailed", quietOpen.emailed.length === 0, quietOpen.emailed.join(", "));
  const noticeRow = await db.query(`select severity from ops_alerts where key = $1`, [K1]);
  check("and the row records why", noticeRow.rows[0]?.severity === "notice");

  await db.query(
    `update ops_alerts set last_notified = now() - interval '7 hours' where key = $1`,
    [K1]
  );
  const quietAgain = await reconcile([finding(K1, "a quiet condition", "notice")]);
  check("a persisting notice is not nagged about", quietAgain.emailed.length === 0);

  console.log("\n[but a notice that gets worse speaks up]");
  /*
    The trap this closes: the notice already holds the key, so the outage it
    turns into would find a row open and say nothing at all. That is worse than
    the noise it replaced — a genuine failure, silent, because a milder version
    of itself got there first.
  */
  const escalated = await reconcile([finding(K1, "now serious", "urgent")]);
  check("escalation is emailed", escalated.emailed.includes(K1), escalated.emailed.join(", "));
  check("without opening a second row", escalated.opened.length === 0);
  const escRow = await db.query(`select severity from ops_alerts where key = $1`, [K1]);
  check("and the row is upgraded", escRow.rows[0]?.severity === "urgent");

  console.log("\n[clearing follows the same rule]");
  const clearedUrgent = await reconcile([]);
  check("an urgent alert reports that it cleared", clearedUrgent.emailed.includes(K1));

  await reconcile([finding(K2, "a quiet condition", "notice")]);
  const clearedNotice = await reconcile([]);
  check("a notice resolves", clearedNotice.resolved.includes(K2));
  check(
    "silently — nobody was told it started",
    clearedNotice.emailed.length === 0,
    clearedNotice.emailed.join(", ")
  );

  /* ================================================= the condition that caused all this */
  /*
    The classification, driven through a real session row.

    One status column, two genuinely different situations, and conflating them
    is what produced seventeen emails: `logged_out` needs somebody to scan a
    code and will never recover alone, while `disconnected` is Baileys doing
    what Baileys does all day. The old check gave both the same thirty-minute
    fuse.
  */
  console.log("\n[a flapping session is not an emergency; an unscanned code is]");
  const { whatsappChecks } = await import("../src/lib/ops-alert");
  const waSaved = (
    await db.query(
      `select clinic_id, status, desired, connected_at from whatsapp_sessions
        where clinic_id in (
          select id from clinics
           where deleted_at is null and subscription_status <> 'suspended')
        limit 1`
    )
  ).rows[0];
  if (!waSaved) {
    check("a session row exists to test with", false, "no usable whatsapp_sessions row");
  } else {
    /*
      Ages are set through `connected_at`, and it has to be that column.

      A `before update` trigger rewrites `updated_at := now()` on every write to
      this table, so a fixture cannot age a row that way at all — an earlier
      draft of this test tried, and every case came back "absent" because the
      row was always zero seconds old. That is not a testing inconvenience: it
      is the reason `whatsappChecks` cannot use `updated_at` either, since a
      down session rewrites it every sixty seconds from the reconnect loop.
    */
    const downFor = async (status: string, hours: number) => {
      await db.query(
        `update whatsapp_sessions set desired = true, status = $2,
                connected_at = now() - ($3 || ' hours')::interval
          where clinic_id = $1`,
        [waSaved.clinic_id, status, String(hours)]
      );
      return (await whatsappChecks()).find(
        (f) => f.key === `whatsapp_down:${waSaved.clinic_id}`
      );
    };
    try {
      check("a 10-minute drop is not reported at all", !(await downFor("disconnected", 1 / 6)));
      const eight = await downFor("disconnected", 8);
      check("an 8-hour drop is recorded", eight?.severity === "notice", eight?.severity ?? "absent");
      const aDay = await downFor("disconnected", 30);
      check(
        "a 30-hour drop is no longer 'reconnecting'",
        aDay?.severity === "urgent",
        aDay?.severity ?? "absent"
      );
      check("a code shown minutes ago waits out the fuse", !(await downFor("qr", 1 / 6)));
      const qr = await downFor("qr", 3);
      check("a code left unscanned is urgent", qr?.severity === "urgent", qr?.severity ?? "absent");
      const out = await downFor("logged_out", 3);
      check("and so is a logged-out session", out?.severity === "urgent", out?.severity ?? "absent");

      // Never connected: asked for, never finished. Onboarding, not an outage.
      await db.query(
        `update whatsapp_sessions set connected_at = null where clinic_id = $1`,
        [waSaved.clinic_id]
      );
      const never = (await whatsappChecks()).find(
        (f) => f.key === `whatsapp_down:${waSaved.clinic_id}`
      );
      check("a session that never connected is not an outage", !never, never?.severity ?? "absent");
    } finally {
      // Restore before anything else can fail: leaving `desired` true here
      // would have a dev worker try to open a socket for this clinic.
      await db.query(
        `update whatsapp_sessions set status = $2, desired = $3, connected_at = $4
          where clinic_id = $1`,
        [waSaved.clinic_id, waSaved.status, waSaved.desired, waSaved.connected_at]
      );
    }
  }

  /* ================================================= the watchdog on the worker */
  console.log("\n[the web app watching the worker]");
  const { watchdogPass } = await import("../src/lib/ops-alert");

  const saved = (await db.query(`select updated_at from worker_status where id = true`)).rows[0];
  await db.query(
    `insert into worker_status (id, ai_ready, whatsapp_ready, version, updated_at)
     values (true, false, false, 'qa', now())
     on conflict (id) do update set updated_at = now()`
  );
  check("a beating heart raises nothing", (await watchdogPass()).length === 0);

  await db.query(`update worker_status set updated_at = now() - interval '20 minutes' where id = true`);
  const dead = await watchdogPass();
  check("a silent worker is reported", dead.length === 1 && dead[0].key === "worker_down", dead[0]?.title ?? "");

  /*
    The scoping that makes two watchers safe. `reconcile` clears anything open
    it was not told about, so a pass that only looks at the worker must not
    resolve the backup alarm — it never looked.
  */
  await db.query(
    `insert into ops_alerts (key, title, detail) values ('qa_test_other', 'Something else', 'x')
     on conflict (key) do nothing`
  );
  await reconcile(dead, (k) => k === "worker_down");
  const survived = await db.query(`select 1 from ops_alerts where key = 'qa_test_other'`);
  check("a scoped pass leaves other alerts alone", survived.rowCount === 1);
  const openedWorker = await db.query(`select 1 from ops_alerts where key = 'worker_down'`);
  check("and opens its own", openedWorker.rowCount === 1);

  /*
    The worker's own pass is unscoped on purpose: it running at all is proof it
    is not down, so it is entitled to clear this.
  */
  await reconcile([]);
  const clearedWorker = await db.query(`select 1 from ops_alerts where key = 'worker_down'`);
  check("a full pass by the worker clears it", clearedWorker.rowCount === 0);

  if (saved?.updated_at) {
    await db.query(`update worker_status set updated_at = $1 where id = true`, [saved.updated_at]);
  }

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
