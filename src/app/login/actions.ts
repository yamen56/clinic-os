"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { actionIp, isThrottled, recordFailure, clearFailures } from "@/lib/auth-throttle";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  createSession,
  setSessionCookie,
  verifyPassword,
  destroySession,
  landingPathFor,
  safeNextPath,
} from "@/lib/auth";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";
import { landingPathIn, resolveCapabilities, type MemberRole } from "@/lib/permissions";
import { maskByFeatures, resolveFeatures } from "@/lib/features";

export type LoginState = { error?: string; to?: string };

/**
 * Signing in resolves its own destination and hands it back to the browser
 * instead of calling `redirect()`.
 *
 * `redirect("/")` from a Server Action is a *client-side* navigation: the
 * router refetches `/`, which then redirects again to the workspace. Two things
 * made that land wrong often enough to look random — the router could answer
 * the hop from a cached, signed-out payload of `/` (bouncing the user straight
 * back to /login), and a redirect issued while rendering an action response can
 * come back with nothing to render (the blank `/`). Neither depends on the
 * cookie, which is why /admin always worked when typed directly.
 *
 * Returning the path and letting the form do a full document load removes both:
 * one destination, computed once, reached by a fresh request that carries the
 * new cookie and starts with an empty router cache.
 */
export async function loginAction(
  _prev: LoginState | null,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "missing" };

  /*
    Checked before the password is, and before the user is even looked up.
    Answering a throttled attempt with the same work as a real one would let the
    response time say whether the account exists, and would keep bcrypt burning
    CPU for whoever is guessing — a rate limit that costs us more than the
    attacker is not one.
  */
  const ip = await actionIp();
  if (await isThrottled("login", ip, email)) return { error: "throttled" };

  const user = await withSystem(async (c) => {
    const r = await c.query(
      "select id, password_hash, locale, is_super_admin from users where lower(email) = $1",
      [email]
    );
    return r.rows[0] ?? null;
  });

  if (!user || !verifyPassword(password, user.password_hash)) {
    await recordFailure("login", ip, email);
    // Still "credentials", never "no such account": the throttle must not become
    // the enumeration oracle the generic message exists to prevent.
    return { error: "credentials" };
  }
  // Proved the account is theirs — forget its failures, but not the address's.
  await clearFailures("login", email);

  const ua = (await headers()).get("user-agent") ?? undefined;
  const token = await createSession(user.id, { userAgent: ua });
  await setSessionCookie(token);
  (await cookies()).set(LOCALE_COOKIE, user.locale, { maxAge: 365 * 86400, path: "/" });

  /*
    The access comes back with the slug, not just the slug.

    Signing in used to send a single-clinic member to `/c/<slug>` and let that
    page sort it out, which was correct while the dashboard was a screen nobody
    could lose. Now that it can be taken away, that costs the member a visible
    bounce on the one screen where the app makes its first impression — the
    guard runs below a `loading.tsx`, so the redirect happens client-side after
    the shell has already painted. Resolving the destination here removes the
    hop entirely, and costs nothing: it is the same query with three more
    columns.
  */
  const memberships = await withSystem(async (c) => {
    await audit(c, { userId: user.id, action: "auth.login" });
    const r = await c.query(
      `select cl.slug, cl.features, cm.role, cm.is_owner, cm.permissions
       from clinic_members cm
       join clinics cl on cl.id = cm.clinic_id
       where cm.user_id = $1 and cm.active
       order by cl.name`,
      [user.id]
    );
    return r.rows as {
      slug: string;
      features: Record<string, unknown> | null;
      role: MemberRole;
      is_owner: boolean;
      permissions: Record<string, unknown> | null;
    }[];
  });
  const clinicSlugs = memberships.map((m) => m.slug);

  const wanted = safeNextPath(String(formData.get("next") ?? ""));
  if (wanted) return { to: wanted };

  const home = landingPathFor({ isSuperAdmin: user.is_super_admin, clinicSlugs });
  /*
    Only the single-clinic case needs refining. `/` and `/admin` are not a
    workspace, and the clinic picker is the right answer for somebody who has
    more than one.
  */
  const only = memberships.length === 1 && !user.is_super_admin ? memberships[0] : null;
  if (!only) return { to: home };

  const caps = maskByFeatures(
    resolveCapabilities(only.permissions, { isOwner: !!only.is_owner, role: only.role }),
    resolveFeatures(only.features)
  );
  return { to: landingPathIn(only.slug, caps) };
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function setLocaleAction(locale: Locale) {
  (await cookies()).set(LOCALE_COOKIE, locale === "en" ? "en" : "ar", {
    maxAge: 365 * 86400,
    path: "/",
  });
}
