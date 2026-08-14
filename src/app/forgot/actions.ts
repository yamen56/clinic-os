"use server";

import { withSystem } from "@/lib/db";
import { createAuthToken, pruneAuthTokens } from "@/lib/invites";
import { sendEmail, renderEmail, emailConfigured } from "@/lib/email";
import { appUrl } from "@/lib/urls";
import { actionIp, isThrottled, recordFailure } from "@/lib/auth-throttle";

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

  /*
    Reports success when throttled, exactly as it does for an unknown address.
    Saying "too many attempts" here would answer the question the generic
    response exists to refuse — whether this address has an account — and this
    form's other job is to not be usable for flooding somebody's inbox.
  */
  const ip = await actionIp();
  if (await isThrottled("reset", ip, email)) return { sent: true };
  await recordFailure("reset", ip, email);

  const url = await withSystem(async (c) => {
    await pruneAuthTokens(c).catch(() => {});
    const u = await c.query(
      `select id, full_name, locale from users where lower(email) = $1`,
      [email]
    );
    if (!u.rowCount) return null;
    const user = u.rows[0];
    // The template names the workspace being recovered; agency staff have no
    // clinic membership, so fall back to the agency name.
    const cn = await c.query(
      `select coalesce(cl.name_ar, cl.name) as n
       from clinic_members m
       join clinics cl on cl.id = m.clinic_id
       where m.user_id = $1 and m.active
       order by m.created_at limit 1`,
      [user.id]
    );
    const clinicName = (cn.rows[0]?.n as string) ?? "Clinicti";

    const raw = await createAuthToken(c, { userId: user.id, purpose: "reset" });
    const link = `${appUrl()}/reset/${raw}`;
    const mail = renderEmail({
      type: "password-reset",
      locale: user.locale === "en" ? "en" : "ar",
      name: user.full_name,
      clinic: clinicName,
      url: link,
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
