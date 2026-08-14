/**
 * Brute force protection, proved rather than assumed.
 *
 * Exercises the throttle directly against the database, because the thing worth
 * testing is the counting and the windowing, not the form. In particular: that
 * a correct password clears the account's failures but not the address's, which
 * is the difference between forgiving a user and forgiving an attacker.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { isThrottled, recordFailure, clearFailures } from "../src/lib/auth-throttle";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok  ${n}`); } else { fails.push(`${n} — ${d}`); console.log(`  FAIL ${n} ${d}`); }
};

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const ipA = `10.0.0.${tag.slice(-2).replace(/\D/g, "") || "7"}-${tag}`;
  const ipB = `10.0.1.${tag}`;
  const mail = `victim-${tag}@test.local`;
  const other = `other-${tag}@test.local`;
  const clean = () =>
    db.query(`delete from auth_attempts where key like $1 or key like $2 or key like $3 or key like $4`,
      [`ip:${ipA}%`, `ip:${ipB}%`, `email:${mail}%`, `email:${other}%`]);
  await clean();

  console.log("\n[the address limit: one machine, many accounts]");
  ok("a fresh address is not throttled", !(await isThrottled("login", ipA, mail)));
  // Ten failures spread across different accounts — the email counter never
  // reaches its own limit, so only the IP rule can catch this.
  for (let i = 0; i < 10; i++) await recordFailure("login", ipA, `acct${i}-${tag}@test.local`);
  ok("ten failures from one address are throttled", await isThrottled("login", ipA, `fresh-${tag}@test.local`));
  ok("a different address is unaffected", !(await isThrottled("login", ipB, `fresh-${tag}@test.local`)));

  console.log("\n[the account limit: many machines, one account]");
  await clean();
  for (let i = 0; i < 15; i++) await recordFailure("login", `10.9.9.${i}-${tag}`, mail);
  ok("fifteen failures on one account are throttled", await isThrottled("login", `10.9.9.200-${tag}`, mail));
  ok("a different account from the same addresses is fine",
    !(await isThrottled("login", `10.9.9.200-${tag}`, other)));

  console.log("\n[a correct password forgives the account, not the address]");
  await clean();
  for (let i = 0; i < 15; i++) await recordFailure("login", ipA, mail);
  ok("throttled before the correct password", await isThrottled("login", ipA, mail));
  await clearFailures("login", mail);
  const ipRows = await db.query(`select count(*)::int n from auth_attempts where key = $1`, [`ip:${ipA}`]);
  ok("the account's failures are cleared", !(await isThrottled("login", `10.9.9.250-${tag}`, mail)));
  ok("the address keeps its record", ipRows.rows[0].n === 15, `${ipRows.rows[0].n} rows`);
  ok("and is still throttled on its own count", await isThrottled("login", ipA, `someone-else-${tag}@test.local`));

  console.log("\n[scopes are independent]");
  await clean();
  for (let i = 0; i < 5; i++) await recordFailure("reset", ipA, mail);
  ok("five reset requests are throttled", await isThrottled("reset", ipA, mail));
  ok("sign-in is not throttled by reset attempts", !(await isThrottled("login", ipA, mail)));

  console.log("\n[the window is real]");
  await clean();
  await db.query(
    `insert into auth_attempts (scope, key, created_at)
     select 'login', $1, now() - interval '20 minutes' from generate_series(1, 20)`,
    [`ip:${ipA}`]
  );
  ok("failures older than the window do not count", !(await isThrottled("login", ipA, mail)));

  await clean();
  await db.end();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
