import { NextResponse } from "next/server";
import { getSession, passwordMatchesUser, markReauthenticated } from "@/lib/auth";
import { readJsonCapped } from "@/lib/public-guard";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { audit } from "@/lib/audit";
import { withSystem } from "@/lib/db";

/**
 * "Prove it is still you", for the few actions where a session is not enough.
 *
 * Called by the client when a dangerous endpoint answers `reauth_required`.
 * On success it stamps the session and the original request is retried; the
 * stamp lasts ten minutes, so doing the same thing twice does not ask twice.
 *
 * **This is a password-checking endpoint, so it is throttled like one.** It sits
 * behind a session, which already narrows it enormously, but a session is
 * exactly what an attacker has in the scenario this defends against — a stolen
 * cookie, being used to guess the password that stands between them and the
 * whole patient list. Ten attempts in fifteen minutes is far more than a person
 * mistyping and far less than a guess.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  /*
    Keyed by session rather than by address. The address is shared by everyone
    in a clinic behind one router, so an IP bucket would let one person's
    fat-fingering lock out the receptionist next to them — and would not slow
    the attacker down, since they hold the session and can come from anywhere.
  */
  if (!rateLimit(`reauth:${session.sessionId}`, 10, 15 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  // Second bucket, so one compromised session cannot be used to grind against
  // the account from many places at once.
  if (!rateLimit(`reauth-ip:${clientIp(req)}`, 20, 15 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const read = await readJsonCapped<{ password?: string }>(req, 4096);
  if (!read.ok) return read.res;

  const ok = await passwordMatchesUser(session.user.id, String(read.body.password ?? ""));
  if (!ok) {
    /*
      Recorded whether or not it succeeds. A run of failures here is somebody
      holding a live session and not knowing the password, which is a far more
      interesting signal than a failed sign-in — and there is no other trace of
      it, because the session itself stays perfectly valid throughout.
    */
    await withSystem((c) =>
      audit(c, {
        userId: session.user.id,
        action: "auth.reauth.failed",
        entity: "session",
        entityId: session.sessionId,
      })
    ).catch(() => {});
    return NextResponse.json({ error: "wrong_password" }, { status: 403 });
  }

  await markReauthenticated(session.sessionId);
  return NextResponse.json({ ok: true });
}
