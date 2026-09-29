"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { hashPassword, verifyPassword, createSession, setSessionCookie } from "@/lib/auth";
import { consumeAuthToken, wasJustConsumed } from "@/lib/invites";
import { withSystem } from "@/lib/db";
import { sendEmail, renderEmail } from "@/lib/email";
import { appUrl } from "@/lib/urls";
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
    Only when this submission is the one that spent the token — the replay path
    above is the same acceptance arriving twice, and must not welcome them twice.
    `after` sends them once the redirect is on its way, so the invitee lands in
    the app instead of waiting on the mail provider.
  */
  if (r.ok) {
    const { userId, clinicSlug } = ok;
    const issuedBy = r.issuedBy ?? null;
    after(async () => {
      await sendWelcomeEmail(userId, clinicSlug);
      if (issuedBy && issuedBy !== userId) await sendJoinedEmail(issuedBy, userId, clinicSlug);
    });
  }

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

/**
 * The welcome that follows an accepted invitation.
 *
 * It carries the two things a new colleague needs on their second device, where
 * the invitation link no longer works: the address to sign in at and the email
 * to sign in with. It doubles as notice that a password was just set, with the
 * way back if that was not them.
 *
 * Same language and workspace name as the invitation they have just read — the
 * clinic's default, or English for an agency invitation, which has no clinic.
 */
async function sendWelcomeEmail(userId: string, clinicSlug: string | null): Promise<void> {
  try {
    const row = await withSystem(async (c) => {
      const r = await c.query(
        `select u.email, u.full_name,
                coalesce(nullif(cl.name_ar, ''), cl.name) as clinic_name, cl.default_locale
           from users u
           left join clinics cl on cl.slug = $2
          where u.id = $1`,
        [userId, clinicSlug]
      );
      return r.rows[0];
    });
    if (!row) return;

    const mail = renderEmail({
      type: "welcome",
      locale: clinicSlug && row.default_locale !== "en" ? "ar" : "en",
      name: row.full_name,
      clinic: (row.clinic_name as string | null) ?? "Clinicti",
      url: clinicSlug ? `${appUrl()}/c/${clinicSlug}` : `${appUrl()}/`,
      email: row.email,
    });
    const sent = await sendEmail({ to: row.email, ...mail });
    if (!sent.ok && !sent.skipped) console.error("[welcome email]", sent.error);
  } catch (e) {
    console.error("[welcome email]", (e as Error).message);
  }
}

/**
 * Tells whoever sent the invitation that it was accepted, so they are not left
 * wondering whether a colleague ever got the email — and are reminded that the
 * new member's access is theirs to review.
 *
 * Written in the inviter's own language, and only while they still belong to
 * that clinic: someone who has since left it should not keep hearing about its
 * staff. The agency is the exception — a super admin who invited a clinic's
 * owner is told too, which is how it learns the clinic is actually onboarded.
 */
async function sendJoinedEmail(
  inviterId: string,
  memberId: string,
  clinicSlug: string | null
): Promise<void> {
  try {
    const row = await withSystem(async (c) => {
      const r = await c.query(
        `select i.email, i.full_name, i.locale, i.is_super_admin,
                m.full_name as member_name, m.email as member_email,
                coalesce(nullif(cl.name_ar, ''), cl.name) as clinic_name,
                exists (select 1 from clinic_members cm
                         where cm.user_id = i.id and cm.clinic_id = cl.id and cm.active) as in_clinic
           from users i
           join users m on m.id = $2
           left join clinics cl on cl.slug = $3
          where i.id = $1`,
        [inviterId, memberId, clinicSlug]
      );
      return r.rows[0];
    });
    if (!row) return;
    if (clinicSlug && !row.in_clinic && !row.is_super_admin) return;

    const path = !clinicSlug
      ? "/admin/team"
      : row.in_clinic
        ? `/c/${clinicSlug}/settings/staff`
        : `/admin/clinics/${clinicSlug}`;
    const mail = renderEmail({
      type: "member-joined",
      locale: row.locale === "en" ? "en" : "ar",
      name: row.full_name,
      clinic: (row.clinic_name as string | null) ?? "Clinicti",
      url: `${appUrl()}${path}`,
      member: { name: row.member_name, email: row.member_email },
    });
    const sent = await sendEmail({ to: row.email, ...mail });
    if (!sent.ok && !sent.skipped) console.error("[joined email]", sent.error);
  } catch (e) {
    console.error("[joined email]", (e as Error).message);
  }
}
