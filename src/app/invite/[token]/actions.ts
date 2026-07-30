"use server";

import { hashPassword, createSession, setSessionCookie } from "@/lib/auth";
import { consumeAuthToken } from "@/lib/invites";
import type { SetPasswordState } from "@/components/set-password-form";

/**
 * Accepts an invitation: sets the password, activates the membership, and signs
 * the user straight in — asking them to log in again immediately after choosing
 * a password is friction with no security benefit, since the token already
 * proved control of the mailbox.
 */
export async function acceptInviteAction(
  _prev: SetPasswordState,
  form: FormData
): Promise<SetPasswordState> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if (password.length < 8) return { error: "tooShort" };
  if (password !== confirm) return { error: "mismatch" };

  const r = await consumeAuthToken(token, "invite", hashPassword(password));
  if (!r.ok || !r.userId) return { error: "invalidToken" };

  const session = await createSession(r.userId);
  await setSessionCookie(session);
  return { to: r.clinicSlug ? `/c/${r.clinicSlug}` : "/" };
}
