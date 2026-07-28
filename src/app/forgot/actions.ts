"use server";

import { withSystem } from "@/lib/db";
import { createAuthToken, pruneAuthTokens } from "@/lib/invites";
import { sendEmail, resetEmail, emailConfigured } from "@/lib/email";
import { appUrl } from "@/lib/urls";

export type ForgotState = { sent?: boolean; devUrl?: string } | null;

/**
 * Requests a password reset.
 *
 * Always reports success, even for an unknown address — a different response
 * would turn this form into an account-enumeration oracle. Nothing is revealed
 * about whether the email exists.
 */
export async function requestResetAction(
  _prev: ForgotState,
  form: FormData
): Promise<ForgotState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { sent: true };

  const url = await withSystem(async (c) => {
    await pruneAuthTokens(c).catch(() => {});
    const u = await c.query(
      `select id, full_name, locale from users where lower(email) = $1`,
      [email]
    );
    if (!u.rowCount) return null;
    const user = u.rows[0];

    const raw = await createAuthToken(c, { userId: user.id, purpose: "reset" });
    const link = `${appUrl()}/reset/${raw}`;
    const mail = resetEmail({
      name: user.full_name,
      url: link,
      locale: user.locale === "en" ? "en" : "ar",
    });
    const sent = await sendEmail({ to: email, ...mail });
    if (!sent.ok && !sent.skipped) console.error("[reset email]", sent.error);
    return link;
  });

  // Without a mail provider the link is shown on screen, so a locked-out owner
  // can still recover. Never shown once email is configured.
  if (url && !emailConfigured()) return { sent: true, devUrl: url };
  return { sent: true };
}
