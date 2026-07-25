import { NextResponse, type NextRequest } from "next/server";

/**
 * Light auth gate: redirect to /login when the session cookie is missing.
 * Real validation happens server-side in the guards.
 */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has("cos_session");
  const { pathname } = req.nextUrl;

  const isProtected =
    pathname.startsWith("/admin") || pathname.startsWith("/c/") || pathname === "/";

  if (isProtected && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/admin/:path*", "/c/:path*"],
};
