"use server";

import { redirect } from "next/navigation";
import { hashPassword, verifyPassword, createSession, setSessionCookie } from "@/lib/auth";
import { consumeAuthToken, wasJustConsumed } from "@/lib/invites";
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
  /*
    The token is spent on the way through, so a submission that reaches the
    server twice fails on the second pass. Before calling the invitation dead,
    check whether we are the ones who spent it a moment ago — the password on the
    account being the one just typed is the proof. See wasJustConsumed.
  */
  const ok =
    r.ok && r.userId
      ? { userId: r.userId, clinicSlug: r.clinicSlug ?? null }
      : await wasJustConsumed(token, "invite", password, verifyPassword);
  if (!ok) return { error: "invalidToken" };

  const session = await createSession(ok.userId);
  await setSessionCookie(session);

  /*
    Redirect here rather than handing a destination back for the client to act
    on, and the difference is not stylistic — the old way did not work.

    Every server action re-renders the route it was called from. By the time this
    returned, the invite page had re-read a token that was now used and swapped
    the form for "this invitation is no longer valid" — unmounting the very
    effect that was supposed to perform the navigation. The password was set, the
    session was real, and the invitee was left staring at an error telling them
    otherwise, with no way forward but to guess that logging in would now work.

    Redirecting from the action makes the navigation part of the action's own
    response, so there is no window in which a re-render can overtake it.
  */
  redirect(ok.clinicSlug ? `/c/${ok.clinicSlug}` : "/");
}
