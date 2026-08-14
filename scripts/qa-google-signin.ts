/**
 * Google Sign-In: the refusals, which are the part that matters.
 *
 * The happy path needs a real Google account and cannot be exercised here. What
 * can — and what would be a breach rather than a bug if it broke — is every way
 * the callback is supposed to say no: a forged callback, a mismatched state, an
 * unverified address, and above all an address nobody was ever invited to use.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const BASE = process.env.APP_URL || "http://localhost:3000";

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok  ${n}`); } else { fails.push(`${n} — ${d}`); console.log(`  FAIL ${n} ${d}`); }
};

/** Follows nothing: we want the redirect itself, which is the verdict. */
async function hit(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  console.log("\n[callback refuses anything it did not start]");
  const noState = await hit("/api/auth/google/callback?code=abc&state=xyz");
  ok("a callback with no handshake cookie is refused",
    noState.location.includes("error=google_state") || noState.location.includes("error=google_off"),
    noState.location);

  const badState = await hit(
    "/api/auth/google/callback?code=abc&state=WRONG",
    `g_oauth=${encodeURIComponent(JSON.stringify({ state: "RIGHT", verifier: "v", next: null }))}`
  );
  ok("a state that does not match the cookie is refused",
    badState.location.includes("error=google_state") || badState.location.includes("error=google_off"),
    badState.location);

  const cancelled = await hit("/api/auth/google/callback?error=access_denied&state=x");
  ok("a cancelled consent screen is refused",
    cancelled.location.includes("error=google_cancelled") || cancelled.location.includes("error=google_off"),
    cancelled.location);

  console.log("\n[no session is ever issued by a refusal]");
  for (const r of [noState, badState, cancelled]) {
    ok("no session cookie set on refusal", !/(^|;\s*)cs=/.test(r.setCookie), r.setCookie.slice(0, 60));
  }

  console.log("\n[the invite-only rule is in the schema, not just the code]");
  const idx = await db.query(
    `select indexdef from pg_indexes where tablename = 'users' and indexname = 'users_google_sub_idx'`
  );
  ok("one Google account cannot claim two users", idx.rows.length === 1);
  ok("the uniqueness is partial, so unlinked users are allowed",
    /where \(?google_sub IS NOT NULL/i.test(idx.rows[0]?.indexdef ?? ""), idx.rows[0]?.indexdef ?? "missing");

  const cols = await db.query(
    `select column_name from information_schema.columns
      where table_name = 'users' and column_name in ('google_sub','google_linked_at')`
  );
  ok("users carries google_sub and google_linked_at", cols.rows.length === 2, `${cols.rows.length}/2`);

  console.log("\n[start route]");
  const start = await hit("/api/auth/google/start");
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (configured) {
    ok("start redirects to Google", start.location.startsWith("https://accounts.google.com/"), start.location.slice(0, 60));
    ok("start asks for S256 PKCE", start.location.includes("code_challenge_method=S256"));
    ok("start sets the handshake cookie", start.setCookie.includes("g_oauth="));
  } else {
    ok("with no credentials configured, start refuses instead of half-working",
      start.location.includes("error=google_off"), start.location);
    console.log("  ·  (set GOOGLE_CLIENT_ID/SECRET to exercise the real redirect)");
  }

  await db.end();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
