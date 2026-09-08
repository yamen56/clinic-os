import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authorizeUrl, googleConfigured, newHandshake, STATE_COOKIE } from "@/lib/google-oauth";
import { safeNextPath } from "@/lib/auth";
import { appUrl } from "@/lib/urls";
import { rateLimit, clientIp } from "@/lib/booking-public";

export const dynamic = "force-dynamic";

/** Begins the handshake. Nothing is decided here; the callback does the work. */
export async function GET(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.redirect(`${appUrl()}/login?error=google_off`);
  }
  /*
    The other two doors into this app — the password form and the booking
    link — have been rate limited since they shipped, and this one was simply
    missed. It is unauthenticated, it sets a cookie, and the callback it leads
    to spends a network round trip at Google on every attempt, so leaving it
    open means anyone can make us do that as fast as they can ask.

    Generous on purpose: a real person signs in with Google once, occasionally
    twice when a tab goes stale. Twenty in ten minutes is nowhere near a person
    and well below anything worth automating.
  */
  if (!rateLimit(`oauth-start:${clientIp(req)}`, 20, 10 * 60_000)) {
    return NextResponse.redirect(`${appUrl()}/login?error=rate_limited`);
  }
  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  const h = newHandshake(next);

  const res = NextResponse.redirect(authorizeUrl(h.state, h.challenge));
  /*
    The state and the PKCE verifier live in one short-lived, httpOnly cookie
    rather than in a table: they are worthless ten minutes from now, and a
    signed-out visitor has no row anywhere to attach them to.
  */
  (await cookies()).set(STATE_COOKIE, h.payload, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/api/auth/google",
  });
  return res;
}
