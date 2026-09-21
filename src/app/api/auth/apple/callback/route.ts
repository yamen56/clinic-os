import { NextResponse } from "next/server";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { cookies, headers } from "next/headers";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createSession, setSessionCookie, landingPathFor, safeNextPath } from "@/lib/auth";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { exchangeAppleCode, appleConfigured, APPLE_STATE_COOKIE } from "@/lib/apple-oauth";
import { appUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

/*
  303, not the 307 that `NextResponse.redirect` defaults to.

  Apple delivers the code by POST. A 307 preserves the method, so the browser
  would re-POST an empty body at /login and land on a 405 instead of the sign-in
  page. 303 is the status that means "now go and GET this".
*/
const fail = (reason: string) =>
  NextResponse.redirect(`${appUrl()}/login?error=${reason}`, 303);

/**
 * Where an Apple identity becomes a Clinicti session, or does not.
 *
 * The rule is the one the Google callback holds and is repeated here rather
 * than shared, because it is the rule the file exists for: **it never creates a
 * user.** Clinicti has no public sign-up — staff arrive by invitation — so a
 * valid Apple ID proves who somebody is, not that they are entitled to
 * anything. Presented with an address nobody invited, the answer is no.
 */
export async function POST(req: Request) {
  if (!appleConfigured()) return fail("apple_off");

  if (!rateLimit(`apple-callback:${clientIp(req)}`, 20, 10 * 60_000)) {
    return fail("rate_limited");
  }

  const jar = await cookies();
  const raw = jar.get(APPLE_STATE_COOKIE)?.value;
  jar.delete(APPLE_STATE_COOKIE);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("apple_state");
  }
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };

  // The user pressed "cancel" on Apple's screen, or something went wrong there.
  if (str("error")) return fail("apple_cancelled");

  const code = str("code");
  const state = str("state");
  if (!code || !state || !raw) return fail("apple_state");

  let saved: { state: string; nonce: string; next: string | null };
  try {
    saved = JSON.parse(raw);
  } catch {
    return fail("apple_state");
  }
  // A callback that does not match the handshake this browser started is not ours.
  if (saved.state !== state) return fail("apple_state");

  /*
    Apple also posts a `user` field carrying the person's name, once and only on
    the very first authorization. We read none of it: the row it would describe
    already exists, was named by whoever invited them, and a display name is not
    something a sign-in button gets to overwrite.
  */
  const identity = await exchangeAppleCode(code, saved.nonce);
  if (!identity) return fail("apple_failed");
  // An unverified address is only a claim — see the Google callback.
  if (!identity.emailVerified) return fail("apple_unverified");

  const outcome = await withSystem(async (c) => {
    /*
      By `apple_sub` first, then by email — the same order and the same reason
      as Google. The sub is Apple's permanent id for this account at this
      Services ID; the address is not, and an address somebody gave up should
      not carry their access to whoever is issued it next.
    */
    const bySub = await c.query(
      `select id, locale, is_super_admin from users where apple_sub = $1`,
      [identity.sub]
    );
    if (bySub.rows[0]) return { user: bySub.rows[0], reason: null };

    /*
      Nothing links this Apple ID yet, so the address has to do the matching —
      and a relay address never will. "Hide My Email" gives us a forwarder at
      privaterelay.appleid.com that no invitation was ever sent to, so the match
      fails for a reason the person can actually fix. Worth its own answer:
      "you aren't registered" would be untrue and would send them to ask their
      clinic for an invitation they already have.
    */
    if (identity.isPrivateEmail) return { user: null, reason: "apple_private_email" };

    const byEmail = await c.query(
      `select id, locale, is_super_admin, apple_sub from users where lower(email) = $1`,
      [identity.email]
    );
    const u = byEmail.rows[0];
    if (!u) return { user: null, reason: "apple_no_account" };
    // Somebody else's Apple ID already claims this row.
    if (u.apple_sub && u.apple_sub !== identity.sub) {
      return { user: null, reason: "apple_no_account" };
    }

    await c.query(
      `update users set apple_sub = $2, apple_linked_at = now(),
              email_verified_at = coalesce(email_verified_at, now())
        where id = $1`,
      [u.id, identity.sub]
    );
    await audit(c, { userId: u.id, action: "auth.apple_linked" });
    return { user: u, reason: null };
  });

  // No invitation, no account. Said plainly rather than as "wrong password".
  if (!outcome.user) return fail(outcome.reason ?? "apple_no_account");
  const user = outcome.user;

  const ua = (await headers()).get("user-agent") ?? undefined;
  const token = await createSession(user.id, { userAgent: ua });
  await setSessionCookie(token);
  jar.set(LOCALE_COOKIE, user.locale, { maxAge: 365 * 86400, path: "/" });

  const clinicSlugs = await withSystem(async (c) => {
    await audit(c, { userId: user.id, action: "auth.login", detail: { via: "apple" } });
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
  return NextResponse.redirect(`${appUrl()}${to}`, 303);
}

/**
 * Nothing should arrive here by GET — the flow is `response_mode=form_post`
 * throughout. Answering rather than 405-ing means a stale tab, a bookmark or a
 * crawler lands on the sign-in page instead of a framework error screen.
 */
export async function GET() {
  return fail("apple_state");
}
