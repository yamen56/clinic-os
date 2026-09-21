/**
 * Sign in with Apple: the refusals, plus the two things the shape depends on.
 *
 * Mirrors qa-google-signin, and for the same reason — the happy path needs a
 * real Apple ID and cannot be exercised here, but every way the callback is
 * supposed to say no can be, and those are the ones that would be a breach
 * rather than a bug.
 *
 * Two assertions here have no Google counterpart and are the ones worth having:
 * the callback must accept a POST (Apple never sends anything else), and it
 * must answer a POST with a 303 — a 307 would re-POST at /login and put a 405
 * in front of every person who signed in successfully.
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
async function post(path: string, fields: Record<string, string>, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields),
  });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  console.log("\n[callback refuses anything it did not start]");
  const noState = await post("/api/auth/apple/callback", { code: "abc", state: "xyz" });
  ok("a callback with no handshake cookie is refused",
    noState.location.includes("error=apple_state") || noState.location.includes("error=apple_off"),
    noState.location);

  const badState = await post(
    "/api/auth/apple/callback",
    { code: "abc", state: "WRONG" },
    `a_oauth=${encodeURIComponent(JSON.stringify({ state: "RIGHT", nonce: "n", next: null }))}`
  );
  ok("a state that does not match the cookie is refused",
    badState.location.includes("error=apple_state") || badState.location.includes("error=apple_off"),
    badState.location);

  const cancelled = await post("/api/auth/apple/callback", { error: "user_cancelled_authorize", state: "x" });
  ok("a cancelled consent screen is refused",
    cancelled.location.includes("error=apple_cancelled") || cancelled.location.includes("error=apple_off"),
    cancelled.location);

  console.log("\n[the POST is answered as a POST, and redirected as a GET]");
  ok("the callback accepts POST — it is the only method Apple uses", noState.status !== 405, String(noState.status));
  ok("a refusal redirects with 303, not 307",
    [303, 302].includes(noState.status), String(noState.status));

  const stray = await get("/api/auth/apple/callback");
  ok("a stray GET lands on the login page rather than a framework error",
    stray.status < 400 && stray.location.includes("/login"), `${stray.status} ${stray.location}`);

  console.log("\n[no session is ever issued by a refusal]");
  for (const r of [noState, badState, cancelled, stray]) {
    ok("no session cookie set on refusal", !/(^|;\s*)cs=/.test(r.setCookie), r.setCookie.slice(0, 60));
  }

  console.log("\n[the invite-only rule is in the schema, not just the code]");
  const idx = await db.query(
    `select indexdef from pg_indexes where tablename = 'users' and indexname = 'users_apple_sub_idx'`
  );
  ok("one Apple ID cannot claim two users", idx.rows.length === 1);
  ok("the uniqueness is partial, so unlinked users are allowed",
    /where \(?apple_sub IS NOT NULL/i.test(idx.rows[0]?.indexdef ?? ""), idx.rows[0]?.indexdef ?? "missing");

  const cols = await db.query(
    `select column_name from information_schema.columns
      where table_name = 'users' and column_name in ('apple_sub','apple_linked_at')`
  );
  ok("users carries apple_sub and apple_linked_at", cols.rows.length === 2, `${cols.rows.length}/2`);

  console.log("\n[start route]");
  const start = await get("/api/auth/apple/start");
  const configured = !!(
    process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY
  );
  if (configured) {
    ok("start redirects to Apple", start.location.startsWith("https://appleid.apple.com/auth/authorize"), start.location.slice(0, 60));
    ok("start asks for form_post — anything else loses the email scope",
      start.location.includes("response_mode=form_post"), start.location);
    ok("start sends a nonce, which stands in for PKCE here",
      /[?&]nonce=[0-9a-f]{8}/.test(start.location), start.location);
    ok("start sets the handshake cookie", start.setCookie.includes("a_oauth="));
    /*
      The whole flow turns on this. Apple posts the code cross-site, and a Lax
      cookie is withheld on a cross-site POST — so a cookie written without
      SameSite=None would make every genuine sign-in fail as a state mismatch,
      and the suite above would still be green.
    */
    ok("the handshake cookie is SameSite=None; Secure, or Apple's POST never carries it",
      /samesite=none/i.test(start.setCookie) && /;\s*secure/i.test(start.setCookie),
      start.setCookie.slice(0, 120));
  } else {
    ok("with no credentials configured, start refuses instead of half-working",
      start.location.includes("error=apple_off"), start.location);
    console.log("  ·  (set APPLE_CLIENT_ID/TEAM_ID/KEY_ID/PRIVATE_KEY to exercise the real redirect)");
  }

  /*
    The one piece that cannot be observed from the outside and is the likeliest
    thing to be silently wrong. Apple's client secret is an ES256 JWS, whose
    signature must be the raw r‖s pair — Node's default for an EC key is DER,
    and handing Apple the DER form fails as `invalid_client`, which reads as a
    wrong key id and sends you to check the wrong four things.

    Signed here with a throwaway P-256 key and verified against its own public
    half, so the encoding is proved without an Apple account and without the
    real .p8 ever being near a test.
  */
  console.log("\n[the client secret is a real ES256 JWT]");
  {
    const { generateKeyPairSync, verify } = await import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const before = { ...process.env };
    process.env.APPLE_CLIENT_ID = "app.clinicti.test";
    process.env.APPLE_TEAM_ID = "TEAM123456";
    process.env.APPLE_KEY_ID = "KEYX000001";
    // Written with the \n escapes a dashboard forces, which is also the form
    // the parser has to tolerate.
    process.env.APPLE_PRIVATE_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString()
      .replace(/\n/g, "\\n");

    const apple = await import("../src/lib/apple-oauth");
    const jwt = apple.clientSecret();
    const [h, p, s] = jwt.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const sig = Buffer.from(s, "base64url");

    ok("a key pasted with \\n escapes still parses", true);
    ok("the header names ES256 and the key id", header.alg === "ES256" && header.kid === "KEYX000001", JSON.stringify(header));
    ok("audience is Apple, subject is the Services ID, issuer is the team",
      claims.aud === "https://appleid.apple.com" && claims.sub === "app.clinicti.test" && claims.iss === "TEAM123456",
      JSON.stringify(claims));
    ok("it expires, and soon", claims.exp - claims.iat > 0 && claims.exp - claims.iat <= 900, String(claims.exp - claims.iat));
    ok("the signature is raw r‖s (64 bytes), not DER", sig.length === 64, `${sig.length} bytes`);
    ok("and it verifies against the key that signed it",
      verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig));

    const authorize = apple.appleAuthorizeUrl("the-state", "the-nonce");
    ok("the authorize URL asks Apple for the email scope",
      authorize.includes("scope=name+email") || authorize.includes("scope=name%20email"), authorize);
    ok("…by form_post, which is what asking for it requires",
      authorize.includes("response_mode=form_post"), authorize);

    process.env = before;
  }

  console.log("\n[the login page still offers a way in]");
  const login = await fetch(`${BASE}/login`);
  const html = await login.text();
  ok("the password form is present whatever the providers are doing",
    html.includes('name="password"'), String(login.status));
  if (configured) {
    ok("the Apple button is rendered", html.includes("/api/auth/apple/start"));
  } else {
    ok("no Apple button when it would lead nowhere", !html.includes("/api/auth/apple/start"));
  }

  await db.end();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
