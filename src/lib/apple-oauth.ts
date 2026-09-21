import { createPrivateKey, randomBytes, sign as signBytes } from "node:crypto";
import { appUrl } from "@/lib/urls";

/**
 * Sign in with Apple, as a third key to the same door.
 *
 * Deliberately shaped like `google-oauth.ts`, because it does the same job and
 * anybody reading one should recognise the other. Three things genuinely differ,
 * and each one is a trap if you assume the Google flow:
 *
 *  1. **There is no client secret.** Apple wants a short-lived ES256 JWT signed
 *     with a key you download once as a `.p8`. It is minted per request here —
 *     it costs one signature and removes a rotation job nobody would remember.
 *
 *  2. **There is no userinfo endpoint.** The identity arrives as an `id_token`
 *     in the token response and nowhere else.
 *
 *  3. **The callback is a cross-site POST.** Asking for `email` obliges
 *     `response_mode=form_post`, which is why the handshake cookie below cannot
 *     be `SameSite=Lax` the way Google's is — the browser would simply not send
 *     it, and every sign-in would fail as a state mismatch.
 *
 * On not verifying the id_token's signature: it is read from the body of a
 * response to a request *we* made to Apple over TLS, not from anything handed
 * to us by the browser. That is the case OpenID Connect §3.1.3.7 names as not
 * requiring signature validation, and it is the same reasoning that keeps the
 * Google flow free of a JWKS fetch. The claims still have to be checked —
 * issuer, audience, expiry and nonce are asserted below — because those guard
 * against a token that is genuine but not ours.
 */

export const APPLE_AUTH = "https://appleid.apple.com/auth/authorize";
export const APPLE_TOKEN = "https://appleid.apple.com/auth/token";
export const APPLE_ISSUER = "https://appleid.apple.com";

export const APPLE_STATE_COOKIE = "a_oauth";

/**
 * Four values, all four required.
 *
 * `APPLE_CLIENT_ID` is the **Services ID** (e.g. `app.clinicti.signin`), not the
 * bundle identifier — a native app and this web flow are two separate clients in
 * Apple's console and only the Services ID can name a web redirect URL.
 */
export function appleConfigured(): boolean {
  return !!(
    process.env.APPLE_CLIENT_ID?.trim() &&
    process.env.APPLE_TEAM_ID?.trim() &&
    process.env.APPLE_KEY_ID?.trim() &&
    process.env.APPLE_PRIVATE_KEY?.trim()
  );
}

export function appleRedirectUri(): string {
  return `${appUrl()}/api/auth/apple/callback`;
}

/**
 * The `.p8` as Apple hands it over, tolerant of how it got into the env.
 *
 * Railway and most dashboards cannot hold a literal newline in a variable, so
 * the key is usually pasted with `\n` escapes. Both forms are accepted; what is
 * not accepted is a key that fails to parse, which throws here rather than
 * producing a signature Apple silently rejects as `invalid_client`.
 */
function privateKey() {
  const pem = process.env.APPLE_PRIVATE_KEY!.trim().replace(/\\n/g, "\n");
  return createPrivateKey(pem);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * Apple's client secret: an ES256 JWT, minted fresh for each exchange.
 *
 * `dsaEncoding: "ieee-p1363"` is the part with no margin for error. Node's
 * default for EC keys is DER, and a JWS signature must be the raw r‖s pair —
 * hand Apple the DER form and it answers `invalid_client`, which reads exactly
 * like a wrong key id.
 */
export function clientSecret(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: process.env.APPLE_KEY_ID!.trim(), typ: "JWT" };
  const claims = {
    iss: process.env.APPLE_TEAM_ID!.trim(),
    iat: now,
    // Apple allows up to six months. Minutes is all this one needs to live.
    exp: now + 300,
    aud: APPLE_ISSUER,
    sub: process.env.APPLE_CLIENT_ID!.trim(),
  };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const sig = signBytes("sha256", Buffer.from(signingInput), {
    key: privateKey(),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${sig.toString("base64url")}`;
}

/**
 * The value that ties a callback to the browser that started it.
 *
 * Apple does not support PKCE, so where Google's handshake carries a verifier
 * this one carries a `nonce` — Apple echoes it inside the id_token, which gives
 * the same guarantee from the other end: a token minted for somebody else's
 * sign-in attempt cannot be replayed into ours.
 */
export function newAppleHandshake(next: string | null) {
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  return { state, nonce, payload: JSON.stringify({ state, nonce, next }) };
}

export function appleAuthorizeUrl(state: string, nonce: string): string {
  const p = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID!.trim(),
    redirect_uri: appleRedirectUri(),
    response_type: "code",
    /*
      Required, not chosen. Apple rejects the authorize request outright if a
      scope beyond `openid` is asked for under the default query response mode,
      and we need `email` — it is the only thing that can be matched against an
      invitation.
    */
    response_mode: "form_post",
    scope: "name email",
    state,
    nonce,
  });
  return `${APPLE_AUTH}?${p}`;
}

export type AppleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** True when the address is an `@privaterelay.appleid.com` forwarder. */
  isPrivateEmail: boolean;
};

/** Apple sends some booleans as the strings "true"/"false". Both are accepted. */
const truthy = (v: unknown) => v === true || v === "true";

export async function exchangeAppleCode(
  code: string,
  nonce: string
): Promise<AppleIdentity | null> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.APPLE_CLIENT_ID!.trim(),
    client_secret: clientSecret(),
    redirect_uri: appleRedirectUri(),
    grant_type: "authorization_code",
  });
  const tok = await fetch(APPLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!tok.ok) return null;
  const { id_token } = (await tok.json()) as { id_token?: string };
  if (!id_token) return null;

  const parts = id_token.split(".");
  if (parts.length !== 3) return null;

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }

  /*
    Four assertions, and none of them is ceremony. `iss` and `aud` reject a
    token minted for a different app, `exp` rejects a stale one, and `nonce`
    rejects one minted for a different sign-in — the case that matters, because
    the other three would all pass for a token Apple genuinely issued to us.
  */
  if (claims.iss !== APPLE_ISSUER) return null;
  if (claims.aud !== process.env.APPLE_CLIENT_ID!.trim()) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
  if (claims.nonce !== nonce) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  if (!sub || !email) return null;

  return {
    sub,
    email,
    emailVerified: truthy(claims.email_verified),
    isPrivateEmail: truthy(claims.is_private_email),
  };
}
