import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authorizeUrl, googleConfigured, newHandshake, STATE_COOKIE } from "@/lib/google-oauth";
import { safeNextPath } from "@/lib/auth";
import { appUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

/** Begins the handshake. Nothing is decided here; the callback does the work. */
export async function GET(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.redirect(`${appUrl()}/login?error=google_off`);
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
