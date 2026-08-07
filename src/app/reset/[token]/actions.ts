"use server";

import { redirect } from "next/navigation";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { consumeAuthToken, wasJustConsumed } from "@/lib/invites";
import type { SetPasswordState } from "@/components/set-password-form";

export async function resetPasswordAction(
  _prev: SetPasswordState,
  form: FormData
): Promise<SetPasswordState> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if (password.length < 8) return { error: "tooShort" };
  if (password !== confirm) return { error: "mismatch" };

  const r = await consumeAuthToken(token, "reset", hashPassword(password));
  // A submission that arrives twice spends the token on the first pass, and
  // telling someone their reset link is dead when it just worked would send them
  // round the forgot-password loop for a password they already have. Same
  // narrow recognition as the invitation; see wasJustConsumed.
  const userId =
    r.ok && r.userId
      ? r.userId
      : (await wasJustConsumed(token, "reset", password, verifyPassword))?.userId;
  if (!userId) return { error: "invalidToken" };

  // Changing a password invalidates every existing session: if the reset was
  // prompted by a compromise, the attacker's session must not survive it.
  await withSystem((c) => c.query(`delete from sessions where user_id = $1`, [userId]));

  // Redirect from the action, not from a client effect. The reset page
  // re-renders once this returns and finds the token spent, which unmounted the
  // form before it could navigate — see the note in the invitation action.
  redirect("/login?reset=1");
}
