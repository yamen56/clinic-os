import { NextResponse, type NextRequest } from "next/server";

/**
 * Light auth gate: redirect to /login when the session cookie is missing.
 * Real validation happens server-side in the guards.
 */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has("cos_session");
  const { pathname } = req.nextUrl;

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

export const config = {
  matcher: ["/", "/admin/:path*", "/c/:path*", "/sign-device/:path*"],
};
