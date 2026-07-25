"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createSession, setSessionCookie, verifyPassword, destroySession } from "@/lib/auth";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";

export async function loginAction(
  _prev: { error: string } | null,
  formData: FormData
): Promise<{ error: string } | null> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "missing" };

  const user = await withSystem(async (c) => {
    const r = await c.query(
      "select id, password_hash, locale from users where lower(email) = $1",
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
  await withSystem((c) => audit(c, { userId: user.id, action: "auth.login" }));
  redirect("/");
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
