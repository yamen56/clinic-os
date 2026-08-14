import { createHash, randomBytes } from "node:crypto";
import { appUrl } from "@/lib/urls";

/**
 * Google Sign-In, as a second key to an existing door.
 *
 * The whole flow is deliberately small: there is no library, no JWT handling
 * and no JWKS fetch, because we never need to trust a token that arrived via
 * the browser. The authorization code is exchanged server-to-server over TLS
 * with Google, and the resulting access token is spent immediately on a direct
 * call to Google's userinfo endpoint. Everything we act on therefore comes
 * straight from the issuer on a channel we opened — which is what makes
 * signature verification unnecessary rather than skipped.
 */

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

export const STATE_COOKIE = "g_oauth";

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

export function redirectUri(): string {
  return `${appUrl()}/api/auth/google/callback`;
}

/**
 * The value that ties a callback to the browser that started it.
 *
 * `state` alone stops a third party from replaying somebody else's callback at
 * us. The verifier is PKCE: not strictly required for a confidential client
 * holding a secret, but it costs two hashes and closes the case where an
 * authorization code is intercepted before we redeem it.
 */
export function newHandshake(next: string | null) {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { state, verifier, challenge, payload: JSON.stringify({ state, verifier, next }) };
}

export function authorizeUrl(state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // We want an email, not an ongoing grant — nothing here is done on the
    // user's behalf later, so there is no refresh token to ask for.
    access_type: "online",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH}?${p}`;
}

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

export async function exchangeCode(code: string, verifier: string): Promise<GoogleIdentity | null> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
    client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const tok = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!tok.ok) return null;
  const { access_token } = (await tok.json()) as { access_token?: string };
  if (!access_token) return null;

  const info = await fetch(GOOGLE_USERINFO, {
    headers: { Authorization: `Bearer ${access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!info.ok) return null;
  const u = (await info.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!u.sub || !u.email) return null;
  return {
    sub: u.sub,
    email: u.email.toLowerCase(),
    emailVerified: u.email_verified === true,
    name: u.name,
    picture: u.picture,
  };
}
