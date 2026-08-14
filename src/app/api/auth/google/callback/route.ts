import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createSession, setSessionCookie, landingPathFor, safeNextPath } from "@/lib/auth";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { exchangeCode, googleConfigured, STATE_COOKIE } from "@/lib/google-oauth";
import { appUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

const fail = (reason: string) => NextResponse.redirect(`${appUrl()}/login?error=${reason}`);

/**
 * Where a Google identity becomes a Clinicti session, or does not.
 *
 * The rule this route exists to hold: **it never creates a user.** Clinicti has
 * no public sign-up — staff arrive by invitation — so a valid Google account
 * proves who somebody is, not that they are entitled to anything. Presented
 * with an address nobody invited, the answer is no.
 */
export async function GET(req: Request) {
  if (!googleConfigured()) return fail("google_off");

  const url = new URL(req.url);
  const jar = await cookies();
  const raw = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);

  // The user pressed "cancel" on Google's screen, or something went wrong there.
  if (url.searchParams.get("error")) return fail("google_cancelled");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !raw) return fail("google_state");

  let saved: { state: string; verifier: string; next: string | null };
  try {
    saved = JSON.parse(raw);
  } catch {
    return fail("google_state");
  }
  // A callback that does not match the handshake this browser started is not ours.
  if (saved.state !== state) return fail("google_state");

  const identity = await exchangeCode(code, saved.verifier);
  if (!identity) return fail("google_failed");
  /*
    An unverified address is only a claim. Google will hand one over for a
    freshly made account, and matching on it would let somebody sign in as a
    real user by registering their address at Google and never proving it.
  */
  if (!identity.emailVerified) return fail("google_unverified");

  const user = await withSystem(async (c) => {
    /*
      By `google_sub` first, then by email.

      The sub is Google's permanent id for the account; the address is not.
      Somebody who changes the email on their Google account should keep their
      Clinicti login, and — more importantly — an address they gave up should
      not carry their access to whoever is issued it next.
    */
    const bySub = await c.query(
      `select id, locale, is_super_admin from users where google_sub = $1`,
      [identity.sub]
    );
    if (bySub.rows[0]) return bySub.rows[0];

    const byEmail = await c.query(
      `select id, locale, is_super_admin, google_sub from users where lower(email) = $1`,
      [identity.email]
    );
    const u = byEmail.rows[0];
    if (!u) return null;
    // Somebody else's Google account already claims this row.
    if (u.google_sub && u.google_sub !== identity.sub) return null;

    await c.query(
      `update users set google_sub = $2, google_linked_at = now(),
              email_verified_at = coalesce(email_verified_at, now())
        where id = $1`,
      [u.id, identity.sub]
    );
    await audit(c, { userId: u.id, action: "auth.google_linked" });
    return u;
  });

  // No invitation, no account. Said plainly rather than as "wrong password".
  if (!user) return fail("google_no_account");

  const ua = (await headers()).get("user-agent") ?? undefined;
  const token = await createSession(user.id, { userAgent: ua });
  await setSessionCookie(token);
  jar.set(LOCALE_COOKIE, user.locale, { maxAge: 365 * 86400, path: "/" });

  const clinicSlugs = await withSystem(async (c) => {
    await audit(c, { userId: user.id, action: "auth.login", detail: { via: "google" } });
    const r = await c.query(
      `select cl.slug from clinic_members cm
       join clinics cl on cl.id = cm.clinic_id
       where cm.user_id = $1 and cm.active
       order by cl.name`,
      [user.id]
    );
    return r.rows.map((x) => x.slug as string);
  });

  const to =
    safeNextPath(saved.next) ??
    landingPathFor({ isSuperAdmin: user.is_super_admin, clinicSlugs });
  return NextResponse.redirect(`${appUrl()}${to}`);
}
