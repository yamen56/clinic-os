import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  appleAuthorizeUrl,
  appleConfigured,
  newAppleHandshake,
  APPLE_STATE_COOKIE,
} from "@/lib/apple-oauth";
import { safeNextPath } from "@/lib/auth";
import { appUrl } from "@/lib/urls";
import { rateLimit, clientIp } from "@/lib/booking-public";

export const dynamic = "force-dynamic";

/** Begins the handshake. Nothing is decided here; the callback does the work. */
export async function GET(req: Request) {
  if (!appleConfigured()) {
    return NextResponse.redirect(`${appUrl()}/login?error=apple_off`);
  }
  // Same budget as the Google door, for the same reason: unauthenticated, sets
  // a cookie, and leads to a route that spends a network round trip at Apple.
  if (!rateLimit(`apple-start:${clientIp(req)}`, 20, 10 * 60_000)) {
    return NextResponse.redirect(`${appUrl()}/login?error=rate_limited`);
  }
  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  const h = newAppleHandshake(next);

  const res = NextResponse.redirect(appleAuthorizeUrl(h.state, h.nonce));
  /*
    `SameSite=None`, which the Google flow does not need and which is not a
    relaxation made for convenience.

    Apple returns the authorization code as a cross-site form POST. A `Lax`
    cookie is withheld on exactly that — it is sent on a top-level GET
    navigation and on nothing else — so the callback would find no handshake and
    refuse every genuine sign-in. `None` requires `Secure`, which is the real
    constraint here: this flow cannot work over plain http, and Apple will not
    accept an `http://localhost` return URL either, so there is nothing to lose
    by demanding it unconditionally rather than following NODE_ENV.

    What `Lax` was protecting is already held by `state`: the callback compares
    the value in this cookie against the one Apple posts back, so a cookie that
    travels cross-site still cannot be used by a cross-site request.
  */
  (await cookies()).set(APPLE_STATE_COOKIE, h.payload, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 600,
    path: "/api/auth/apple",
  });
  return res;
}
