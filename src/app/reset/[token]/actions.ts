"use server";

import { redirect } from "next/navigation";
import { hashPassword } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { consumeAuthToken } from "@/lib/invites";
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
  if (!r.ok || !r.userId) return { error: "invalidToken" };

  // Changing a password invalidates every existing session: if the reset was
  // prompted by a compromise, the attacker's session must not survive it.
  await withSystem((c) => c.query(`delete from sessions where user_id = $1`, [r.userId]));

  redirect("/login?reset=1");
}
