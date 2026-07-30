"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
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

  const user = await withSystem(async (c) => {
    const r = await c.query(
      "select id, password_hash, locale, is_super_admin from users where lower(email) = $1",
      [email]
    );
    return r.rows[0] ?? null;
  });

  if (!user || !verifyPassword(password, user.password_hash)) {
    return { error: "credentials" };
  }

  const ua = (await headers()).get("user-agent") ?? undefined;
  const token = await createSession(user.id, { userAgent: ua });
  await setSessionCookie(token);
  (await cookies()).set(LOCALE_COOKIE, user.locale, { maxAge: 365 * 86400, path: "/" });

  const clinicSlugs = await withSystem(async (c) => {
    await audit(c, { userId: user.id, action: "auth.login" });
    const r = await c.query(
      `select cl.slug from clinic_members cm
       join clinics cl on cl.id = cm.clinic_id
       where cm.user_id = $1 and cm.active
       order by cl.name`,
      [user.id]
    );
    return r.rows.map((x) => x.slug as string);
  });

  const wanted = safeNextPath(String(formData.get("next") ?? ""));
  return { to: wanted ?? landingPathFor({ isSuperAdmin: user.is_super_admin, clinicSlugs }) };
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
