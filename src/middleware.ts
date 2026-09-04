import { NextResponse, type NextRequest } from "next/server";
import { allow, floodKey } from "@/lib/flood-gate";

/**
 * Light auth gate: redirect to /login when the session cookie is missing.
 * Real validation happens server-side in the guards.
 *
 * It is also where load is shed. Everything below runs before routing, so a
 * refused request costs a map lookup instead of a database connection — and a
 * connection is the scarce thing, since `PG_POOL_MAX` is 12 and a page that
 * cannot get one fails for a logged-in doctor exactly as it does for an
 * attacker.
 */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has("cos_session");
  const { pathname } = req.nextUrl;

  /*
    The flood gate covers the pages that authorise themselves — the booking
    link, the invoice, the signing page — plus the sign-in forms. Those render
    server-side and query the database, and they had no limit of any kind.

    Sessioned traffic is exempt: a session was issued by us and can be revoked
    by us, the workspace is where the long-polling and the autosaves live, and a
    clinic sharing one office address should never be able to lock itself out of
    its own patient records. The API routes under /api/public keep their own
    tighter, per-endpoint counters; this is the floor, not a replacement.
  */
  const caller = hasSession
    ? null
    : floodKey(req.headers.get("x-forwarded-for"), req.headers.get("x-real-ip"));
  if (caller && !allow(caller)) {
    return new NextResponse(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
        "Cache-Control": "no-store",
      },
    });
  }

  /*
    `/sign/*` is deliberately absent: that is the patient's link, and it
    authorises itself with its token. `/sign-device/*` is the clinic tablet and
    does need a staff session.
  */
  const isProtected =
    pathname.startsWith("/admin") ||
    pathname.startsWith("/c/") ||
    pathname.startsWith("/sign-device/") ||
    pathname === "/";

  if (isProtected && !hasSession) {
    const search = req.nextUrl.search;
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Keep where they were headed, so signing in resumes the deep link instead
    // of dropping everyone on the dashboard. `/` is the default anyway.
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    const res = NextResponse.redirect(url);
    // True only for the request that carried no cookie — nothing between here
    // and the browser may reuse it for the next visitor.
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  return NextResponse.next();
}

/**
 * Static assets are deliberately absent — they are served without touching the
 * database, and metering them would spend more on the counter than on the file.
 *
 * `/api/public/:path*` is listed even though every route under it already
 * counts its own callers, because the one that did not was found by reading the
 * directory rather than by anything failing. A floor that covers a route the
 * day it is added is worth more than one that has to be remembered.
 */
export const config = {
  matcher: [
    "/",
    "/admin/:path*",
    "/c/:path*",
    "/sign-device/:path*",
    "/book/:path*",
    "/inv/:path*",
    "/sign/:path*",
    "/invite/:path*",
    "/reset/:path*",
    "/login",
    "/forgot",
    "/api/public/:path*",
  ],
};
