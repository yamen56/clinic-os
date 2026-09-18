/**
 * Proves two workers can share the clinics without ever sharing a socket.
 *
 * The lease is what allows a second worker to exist at all (migration 0054),
 * and the failure it prevents is invisible from inside the code: two processes
 * both connect the same clinic, WhatsApp answers the newer one with
 * `connectionReplaced`, and the pair spend the day knocking each other off
 * while the clinic's messages stop. Nothing throws. Nothing is logged as an
 * error. So the mutual exclusion is asserted here rather than trusted.
 *
 * Two genuine module instances, not two arguments to one: the worker identity
 * is module state, and a test that passes it as a parameter would be proving
 * something the real code does not do. Loading the module twice under
 * different `RAILWAY_REPLICA_ID` values gives two workers that are as separate
 * as two containers.
 */
import "../worker/env";
import { Client } from "pg";

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

type Leases = typeof import("../worker/wa/leases");

/** One worker's view of the module, with its own identity. */
function loadWorker(id: string, env: Record<string, string> = {}): Leases {
  const overrides = { RAILWAY_REPLICA_ID: id, ...env };
  const restore = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    // The module reads its identity and its budget once, at load. A second
    // instance is the only way to have two of them in one process.
    delete require.cache[require.resolve("../worker/wa/leases")];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../worker/wa/leases") as Leases;
  } finally {
    for (const [k, v] of restore) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SUPER = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

async function main() {
  console.log("▶ whatsapp session leases");
  const su = new Client({ connectionString: SUPER });
  await su.connect();

  // Leftovers from a failed run, so the suite is re-runnable.
  await su.query(`delete from clinics where slug like 'lease-test-%'`);

  const clinics: string[] = [];
  for (const tag of ["a", "b", "c"]) {
    const r = await su.query(
      `insert into clinics (name, slug) values ($1, $2) returning id`,
      [`Lease Test ${tag}`, `lease-test-${tag}`]
    );
    clinics.push(r.rows[0].id as string);
  }
  const [A, B, C] = clinics;
  await su.query(
    `insert into whatsapp_sessions (clinic_id, desired) select unnest($1::uuid[]), true`,
    [clinics]
  );

  const w1 = loadWorker("worker-one");
  const w2 = loadWorker("worker-two");

  try {
    check("two workers have different identities", w1.WORKER_ID !== w2.WORKER_ID);

    /*
      The race, run as a race. Both workers scan the same three unclaimed
      clinics at the same moment and both try to take all of them; Postgres is
      what decides, so the assertion is that the two answers do not overlap.
    */
    const [took1, took2] = await Promise.all([w1.claimSessions(10), w2.claimSessions(10)]);
    const overlap = took1.filter((id) => took2.includes(id));
    check("a clinic is never claimed by two workers", overlap.length === 0, `overlap ${overlap.length}`);
    check(
      "every clinic is claimed by someone",
      new Set([...took1, ...took2]).size === 3,
      `${took1.length} + ${took2.length}`
    );

    const claimedAgain = await w2.claimSessions(10);
    check("a held lease cannot be taken", claimedAgain.length === 0, `took ${claimedAgain.length}`);

    /*
      What the owner sees versus what everyone else sees. Both must agree on
      who owns a clinic, or the reconcile loop in one worker will start a
      socket the other is already running.
    */
    const seen1 = await w1.renewAndRead([]);
    const seen2 = await w2.renewAndRead([]);
    const owner1 = new Map(seen1.map((r) => [r.clinicId, r.ownerId]));
    const owner2 = new Map(seen2.map((r) => [r.clinicId, r.ownerId]));
    check(
      "both workers agree on every owner",
      clinics.every((id) => owner1.get(id) === owner2.get(id)),
      [...owner1.values()].join(", ")
    );
    check(
      "every clinic reads as owned",
      clinics.every((id) => !!owner1.get(id))
    );

    // Whoever holds A, from here on.
    const ownerOfA = owner1.get(A) === w1.WORKER_ID ? w1 : w2;
    const otherThanA = ownerOfA === w1 ? w2 : w1;

    /*
      A lease that stopped being renewed is a worker that died. Backdating the
      heartbeat is the only honest way to test it — waiting out the real TTL
      would put forty-five seconds into every run.
    */
    await su.query(
      `update wa_session_leases set heartbeat_at = now() - interval '90 seconds' where clinic_id = $1`,
      [A]
    );
    const rescued = await otherThanA.claimSessions(10);
    check("a dead worker's clinic is picked up", rescued.includes(A));
    const afterRescue = await w1.renewAndRead([]);
    check(
      "the new owner is the one that claimed it",
      afterRescue.find((r) => r.clinicId === A)?.ownerId === otherThanA.WORKER_ID
    );

    /*
      The counterpart: renewing has to actually move the heartbeat, or every
      lease expires under a healthy worker and the fleet spends its life
      stealing clinics from itself.
    */
    await su.query(
      `update wa_session_leases set heartbeat_at = now() - interval '30 seconds' where clinic_id = $1`,
      [B]
    );
    const ownerOfB = (await w1.renewAndRead([])).find((r) => r.clinicId === B)!.ownerId;
    const workerB = ownerOfB === w1.WORKER_ID ? w1 : w2;
    await workerB.renewAndRead([{ clinicId: B, connected: true }]);
    const age = (
      await su.query(
        `select extract(epoch from now() - heartbeat_at) as s from wa_session_leases where clinic_id = $1`,
        [B]
      )
    ).rows[0].s as string;
    check("renewing moves the heartbeat", Number(age) < 5, `${Number(age).toFixed(1)}s old`);

    /*
      Liveness, which is what admin monitoring reads. "A worker is responsible
      for this clinic" and "a socket is actually up" are different facts and
      the screen exists to catch them disagreeing.
    */
    const live = await w1.liveSessions();
    check("a connected socket is published", live.find((s) => s.clinicId === B)?.connected === true);
    await workerB.renewAndRead([{ clinicId: B, connected: false }]);
    const afterDrop = await w1.liveSessions();
    check(
      "a dropped socket is published immediately",
      afterDrop.find((s) => s.clinicId === B)?.connected === false
    );

    // Restart requests reach the owner.
    await su.query(`update whatsapp_sessions set restart_seq = restart_seq + 1 where clinic_id = $1`, [C]);
    const withRestart = await w1.renewAndRead([]);
    check("a restart request is visible to the owner", withRestart.find((r) => r.clinicId === C)?.restartSeq === "1");

    // And so do logout requests.
    await su.query(`update whatsapp_sessions set logout_requested = true, desired = false where clinic_id = $1`, [C]);
    const withLogout = await w1.renewAndRead([{ clinicId: C, connected: true }]);
    const rowC = withLogout.find((r) => r.clinicId === C);
    check("a disconnected clinic reads as unwanted", rowC?.wanted === false);
    check("the owed logout is visible to the owner", rowC?.logoutRequested === true);
    await w1.clearLogoutRequest(C);
    const cleared = await w1.renewAndRead([{ clinicId: C, connected: true }]);
    check(
      "a performed logout is not performed twice",
      cleared.find((r) => r.clinicId === C)?.logoutRequested === false
    );

    /*
      A soft-deleted clinic must stop being run. It was `desired` when it was
      deleted and the column is not always cleared, so the join is the thing
      standing between a closed clinic and a number that keeps sending.
    */
    await su.query(`update clinics set deleted_at = now() where id = $1`, [B]);
    const afterDelete = await w1.renewAndRead([{ clinicId: B, connected: true }]);
    check("a deleted clinic reads as unwanted", afterDelete.find((r) => r.clinicId === B)?.wanted === false);

    // Releasing is owner-scoped: handing back somebody else's lease would give
    // their live socket away to a third worker.
    // Asked with C as a local session: it is no longer desired, and the read
    // deliberately only returns what is wanted or what the caller is running.
    const ownerOfC = (await w1.renewAndRead([{ clinicId: C, connected: false }])).find(
      (r) => r.clinicId === C
    )!.ownerId;
    const workerC = ownerOfC === w1.WORKER_ID ? w1 : w2;
    const notOwnerC = workerC === w1 ? w2 : w1;
    await notOwnerC.releaseLease(C);
    const stillThere = (
      await su.query(`select count(*)::int as n from wa_session_leases where clinic_id = $1`, [C])
    ).rows[0].n as number;
    check("a lease cannot be released by a stranger", stillThere === 1);
    await workerC.releaseLease(C);
    const gone = (
      await su.query(`select count(*)::int as n from wa_session_leases where clinic_id = $1`, [C])
    ).rows[0].n as number;
    check("the owner can release its own lease", gone === 0);

    // Shutdown hands back everything this worker held, and nothing else.
    const held = async (id: string) =>
      (await su.query(`select count(*)::int as n from wa_session_leases where owner_id = $1`, [id]))
        .rows[0].n as number;
    const before1 = await held(w1.WORKER_ID);
    const before2 = await held(w2.WORKER_ID);
    await w1.releaseAllLeases();
    check("shutdown releases this worker's leases", (await held(w1.WORKER_ID)) === 0, `had ${before1}`);
    check(
      "shutdown leaves the other worker alone",
      (await held(w2.WORKER_ID)) === before2,
      `held ${before2}`
    );

    /*
      The budget is what divides the clinics once there is more than one
      worker. Unlimited stays the default because deploying the lease must not
      strand a clinic that a single worker was already running.
    */
    const capped = loadWorker("worker-capped", { WA_MAX_SESSIONS_PER_WORKER: "2" });
    check("a budget limits what a worker takes on", capped.sessionBudget(2) === 0 && capped.sessionBudget(1) === 1);
    check("no budget means no limit", w1.sessionBudget(500) > 0);
  } finally {
    await su.query(`delete from clinics where slug like 'lease-test-%'`);
    await su.end();
    // Both instances share one pool: only the lease module is reloaded, so
    // `worker/db` is still the single module it is in a running worker.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await (require("../worker/db") as typeof import("../worker/db")).pool.end().catch(() => {});
  }

  console.log(`\nwa lease tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
