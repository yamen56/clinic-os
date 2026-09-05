/**
 * How long is a stolen cookie worth something, and what can it do?
 *
 * A session used to last thirty days from creation, full stop. It did not
 * matter whether anybody had touched it since, and every action inside it was
 * equally available — including handing over every patient record in the clinic
 * as one file. For a workspace holding medical records that is a laptop left in
 * a taxi being worth a month of unrestricted access.
 *
 * Two limits now, and this proves both against the real code path rather than
 * against a copy of the query: sessions are written straight into the database
 * and then presented to a running server as a cookie, exactly as a browser
 * would. A test that re-implemented the idle check would pass while the
 * application did something else entirely.
 *
 *   npx tsx scripts/qa-session-hardening.ts
 *
 * Needs the local stack (`npm run dev:all`).
 */
import { Client } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { hasRecentAuth, markReauthenticated, passwordMatchesUser, hashPassword } from "../src/lib/auth";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const IDLE_DAYS = Number(process.env.SESSION_IDLE_DAYS) || 7;

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

/** The storage format for a session token — sha256 hex, as lib/auth writes it. */
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);

  const password = `Correct-Horse-${tag}`;
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1, $2, 'QA Session')
       returning id`,
      [`qa-sess-${tag}@test.local`, hashPassword(password)]
    )
  ).rows[0];
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Session', 'جلسة', $1) returning id`,
      [`qasess${tag}`]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'other', true, '{"level":"full"}')`,
    [clinic.id, user.id]
  );
  await db.query(
    `insert into patients (clinic_id, full_name) values ($1, 'مريض الاختبار')`,
    [clinic.id]
  );

  /** Writes a session row directly, with whatever age we want to test. */
  async function makeSession(lastSeenSql: string, expiresSql = `now() + interval '30 days'`) {
    const token = randomBytes(32).toString("hex");
    const r = await db.query(
      `insert into sessions (token_hash, user_id, expires_at, last_seen_at)
       values ($1, $2, ${expiresSql}, ${lastSeenSql}) returning id`,
      [hashToken(token), user.id]
    );
    return { token, id: r.rows[0].id as string };
  }
  const call = (token: string, path = "/api/me/notifications") =>
    fetch(`${BASE}${path}`, { headers: { Cookie: `cos_session=${token}` } });

  try {
    /* ============================================== the idle window */
    console.log("\n[a session that nobody has used stops working]");
    const fresh = await makeSession("now()");
    check("a session in use is accepted", (await call(fresh.token)).status === 200);

    const idle = await makeSession(`now() - interval '${IDLE_DAYS + 1} days'`);
    check(
      `one idle for ${IDLE_DAYS + 1} days is refused`,
      (await call(idle.token)).status === 401
    );

    const nearly = await makeSession(`now() - interval '${IDLE_DAYS} days' + interval '2 hours'`);
    check("one just inside the window still works", (await call(nearly.token)).status === 200);

    /*
      The failure this ordering exists to prevent. The refresh and the check run
      in one statement, so if the refresh were unconditional it would stamp
      last_seen_at on the very request that should have been refused — and the
      session would live forever, one rejected request at a time.
    */
    /*
      A fresh stale session, untouched by any earlier request in this file.

      The first version of this reused `idle` above, and that hid the bug it was
      written for: the refusal had already resurrected the row, so by the time
      the "before" value was read it was a fresh timestamp and comparing it to
      "after" compared two identical fresh values. Only the follow-up request
      caught it. Both assertions are kept — one names the cause, one names the
      consequence — but the reading has to happen before anything has called it.
    */
    console.log("\n[and being refused does not revive it]");
    const zombie = await makeSession(`now() - interval '${IDLE_DAYS + 1} days'`);
    const before = (
      await db.query(`select last_seen_at from sessions where id = $1`, [zombie.id])
    ).rows[0].last_seen_at;
    check("it is refused", (await call(zombie.token)).status === 401);
    const after = (
      await db.query(`select last_seen_at from sessions where id = $1`, [zombie.id])
    ).rows[0].last_seen_at;
    check(
      "the refusal did not stamp last_seen",
      new Date(before).getTime() === new Date(after).getTime(),
      `${new Date(before).toISOString()} -> ${new Date(after).toISOString()}`
    );
    check("so it stays refused", (await call(zombie.token)).status === 401);

    /* ============================================== the absolute cap */
    console.log("\n[the thirty-day cap still applies on top]");
    const expired = await makeSession("now()", `now() - interval '1 hour'`);
    check("an expired session is refused even though it is in use", (await call(expired.token)).status === 401);

    /* ============================================== the lazy touch */
    console.log("\n[last_seen is refreshed, but not on every request]");
    const stale = await makeSession(`now() - interval '20 minutes'`);
    const t0 = (await db.query(`select last_seen_at from sessions where id = $1`, [stale.id]))
      .rows[0].last_seen_at;
    check("it is accepted", (await call(stale.token)).status === 200);
    const t1 = (await db.query(`select last_seen_at from sessions where id = $1`, [stale.id]))
      .rows[0].last_seen_at;
    check(
      "a stale-but-valid session is refreshed",
      new Date(t1).getTime() > new Date(t0).getTime()
    );
    // Now it is fresh, so a second request must not write again.
    await call(stale.token);
    const t2 = (await db.query(`select last_seen_at from sessions where id = $1`, [stale.id]))
      .rows[0].last_seen_at;
    check(
      "a recently-seen session is not written again",
      new Date(t2).getTime() === new Date(t1).getTime(),
      "no write per request"
    );

    /* ============================================== re-authentication */
    console.log("\n[the password, again, for the dangerous things]");
    const owner = await makeSession("now()");
    check("a new session has not re-authenticated", (await hasRecentAuth(owner.id)) === false);
    await markReauthenticated(owner.id);
    check("and has once the password is given", (await hasRecentAuth(owner.id)) === true);
    await db.query(`update sessions set reauth_at = now() - interval '30 minutes' where id = $1`, [
      owner.id,
    ]);
    check("but it lapses", (await hasRecentAuth(owner.id)) === false);

    console.log("\n[checking the password]");
    check("the right password is accepted", (await passwordMatchesUser(user.id, password)) === true);
    check("a wrong one is not", (await passwordMatchesUser(user.id, "nope")) === false);
    check("an empty one is not", (await passwordMatchesUser(user.id, "")) === false);
    /*
      An invited-but-not-accepted account has a null hash. bcrypt would throw on
      it; treating it as a pass would make "never set a password" the easiest
      way through this gate.
    */
    const noPass = (
      await db.query(
        `insert into users (email, password_hash, full_name) values ($1, null, 'No Password') returning id`,
        [`qa-nopass-${tag}@test.local`]
      )
    ).rows[0];
    check(
      "an account with no password cannot re-authenticate",
      (await passwordMatchesUser(noPass.id, "anything")) === false
    );
    await db.query(`delete from users where id = $1`, [noPass.id]);

    /* ============================================== the gate, live */
    console.log("\n[live: exporting every record asks for the password]");
    const slug = `qasess${tag}`;
    await db.query(`update sessions set reauth_at = null where id = $1`, [owner.id]);
    const blocked = await call(owner.token, `/api/c/${slug}/patients/export-all?format=xlsx`);
    const blockedBody = (await blocked.json().catch(() => ({}))) as { error?: string };
    check(
      "the export is refused without a recent password",
      blocked.status === 403 && blockedBody.error === "reauth_required",
      `HTTP ${blocked.status} ${blockedBody.error ?? ""}`
    );

    // The real recovery path: POST the password, then retry the same URL.
    const reauth = await fetch(`${BASE}/api/me/reauth`, {
      method: "POST",
      headers: { Cookie: `cos_session=${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    check("the password is accepted by /api/me/reauth", reauth.status === 200, `HTTP ${reauth.status}`);
    const allowed = await call(owner.token, `/api/c/${slug}/patients/export-all?format=xlsx`);
    check("and the export then succeeds", allowed.status === 200, `HTTP ${allowed.status}`);

    console.log("\n[a wrong password does not open it]");
    const other = await makeSession("now()");
    const bad = await fetch(`${BASE}/api/me/reauth`, {
      method: "POST",
      headers: { Cookie: `cos_session=${other.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "definitely-not-it" }),
    });
    check("a wrong password is refused", bad.status === 403, `HTTP ${bad.status}`);
    check("and the session is still not authorised", (await hasRecentAuth(other.id)) === false);
    const stillBlocked = await call(other.token, `/api/c/${slug}/patients/export-all?format=xlsx`);
    check("so the export stays shut", stillBlocked.status === 403, `HTTP ${stillBlocked.status}`);
    const failedAudit = (
      await db.query(
        `select count(*)::int n from audit_log where action = 'auth.reauth.failed' and user_id = $1`,
        [user.id]
      )
    ).rows[0].n;
    check("the failed attempt is recorded", Number(failedAudit) >= 1, `${failedAudit} row(s)`);
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [user.id]);
    await db.end();
  }

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
