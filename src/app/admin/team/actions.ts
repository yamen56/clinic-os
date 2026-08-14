"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminCap } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createAuthToken } from "@/lib/invites";
import { sendEmail, renderEmail } from "@/lib/email";
import { appUrl } from "@/lib/urls";
import {
  ADMIN_CAPABILITIES,
  toAdminAccessSetting,
  type AdminCapability,
  type AdminCapabilityMap,
} from "@/lib/admin-permissions";

/**
 * The agency's own team.
 *
 * Every action here is gated on `admins`, which is the capability that can
 * grant every other capability — including itself. That makes it the one worth
 * being careful with, and the care is concentrated in two rules that appear in
 * each mutation below:
 *
 *   1. You cannot edit yourself. Not a courtesy: the failure mode is somebody
 *      removing their own `admins` tick and locking the only door back in.
 *   2. The last full admin cannot be limited or removed. A platform whose
 *      entire admin team has partial access has no way to grant anybody the
 *      missing part, and the fix is a hand-written SQL update on production.
 */

const capsSchema = z.record(z.string(), z.boolean()).default({});

const inviteSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  level: z.enum(["full", "custom"]),
  caps: capsSchema,
});

function toMap(raw: Record<string, boolean>): AdminCapabilityMap {
  return Object.fromEntries(
    ADMIN_CAPABILITIES.map((c) => [c, raw[c] === true])
  ) as AdminCapabilityMap;
}

/** How many people can still change anybody's access, excluding one user. */
async function fullAdminsBesides(
  c: import("pg").PoolClient,
  excludeUserId: string
): Promise<number> {
  const r = await c.query(
    `select count(*)::int as n from users
      where is_super_admin and id <> $1
        and coalesce(admin_permissions->>'level', 'full') <> 'custom'`,
    [excludeUserId]
  );
  return r.rows[0].n as number;
}

export type TeamResult = { error?: string; url?: string; emailed?: boolean };

/**
 * Adds an agency admin.
 *
 * Same shape as onboarding a clinic owner, and for the same reason: the
 * invitee sets their own password from an emailed link, so nobody here ever
 * chooses, sees or forwards a credential. An account that already exists —
 * typically a clinic owner the agency has now hired — is promoted rather than
 * duplicated, because a second row on the same email is a login that silently
 * resolves to whichever one the lookup happens to find first.
 */
export async function inviteAdminAction(input: unknown): Promise<TeamResult> {
  const s = await requireAdminCap("admins");
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const permissions = toAdminAccessSetting(d.level, toMap(d.caps));

  const outcome = await withSystem(async (c) => {
    const existing = await c.query(
      `select id, full_name, is_super_admin, password_hash from users where lower(email) = $1`,
      [d.email.toLowerCase()]
    );

    let userId: string;
    let needsInvite: boolean;
    if (existing.rowCount) {
      const u = existing.rows[0];
      if (u.is_super_admin) return { error: "already_admin" as const };
      userId = u.id as string;
      await c.query(
        `update users set is_super_admin = true, admin_permissions = $2 where id = $1`,
        [userId, JSON.stringify(permissions)]
      );
      /*
        Only somebody who has never set a password gets a link. Promoting an
        existing clinic owner must not email them what is functionally a
        password reset — they already have a working sign-in, and /admin simply
        appears in it the next time they load a page.
      */
      needsInvite = !u.password_hash;
    } else {
      const r = await c.query(
        `insert into users (email, full_name, is_super_admin, admin_permissions)
         values ($1, $2, true, $3) returning id`,
        [d.email, d.fullName, JSON.stringify(permissions)]
      );
      userId = r.rows[0].id as string;
      needsInvite = true;
    }

    await audit(c, {
      userId: s.user.id,
      action: "admin.team.invite",
      entity: "user",
      entityId: userId,
      detail: { email: d.email, level: d.level, promoted: !!existing.rowCount },
    });
    return { userId, needsInvite, name: (existing.rows[0]?.full_name as string) || d.fullName };
  });

  if ("error" in outcome) return outcome;
  revalidatePath("/admin/team");
  if (!outcome.needsInvite) return { emailed: false };

  // Outside the transaction: a mail provider that hangs must not hold a
  // Postgres connection open, and the account is usable either way.
  return sendAdminInvite(outcome.userId, d.email, outcome.name, s.user.id);
}

/**
 * Issues the invitation and mails it.
 *
 * `clinicId` is null — this is an invitation to the agency, not to a workspace —
 * which the token table, the accept page and `consumeAuthToken` all already
 * handle: a token without a clinic sets a password and activates no membership.
 *
 * The URL comes back regardless of whether the mail was accepted. Only somebody
 * with the `admins` capability can reach this, and they are inviting a
 * colleague they are presumably in a room with; a colleague who never received
 * the email is otherwise a dead end with no remedy but recreating the account.
 */
async function sendAdminInvite(
  userId: string,
  email: string,
  name: string,
  createdBy: string
): Promise<TeamResult> {
  const raw = await withSystem((c) =>
    createAuthToken(c, { userId, clinicId: null, purpose: "invite", createdBy })
  );
  const url = `${appUrl()}/invite/${raw}`;
  const sent = await sendEmail({
    to: email,
    ...renderEmail({ type: "invitation", locale: "en", name, clinic: "Clinicti", url }),
  });
  if (!sent.ok && !sent.skipped) console.error("[admin invite email]", sent.error);
  return { url, emailed: sent.ok };
}

/** Re-issues an admin invitation, invalidating any previous link. */
export async function resendAdminInviteAction(userId: string): Promise<TeamResult> {
  const s = await requireAdminCap("admins");
  const u = await withSystem(async (c) => {
    const r = await c.query(
      `select email, full_name, password_hash, is_super_admin from users where id = $1`,
      [userId]
    );
    return r.rows[0] as
      | { email: string; full_name: string; password_hash: string | null; is_super_admin: boolean }
      | undefined;
  });
  if (!u || !u.is_super_admin) return { error: "not_found" };
  if (u.password_hash) return { error: "already_active" };
  return sendAdminInvite(userId, u.email, u.full_name, s.user.id);
}

const updateSchema = z.object({
  userId: z.string().uuid(),
  level: z.enum(["full", "custom"]),
  caps: capsSchema,
});

export async function updateAdminAccessAction(input: unknown): Promise<TeamResult> {
  const s = await requireAdminCap("admins");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (d.userId === s.user.id) return { error: "self" };

  const permissions = toAdminAccessSetting(d.level, toMap(d.caps));

  return withSystem(async (c) => {
    const target = await c.query(
      `select is_super_admin, coalesce(admin_permissions->>'level', 'full') as level
         from users where id = $1`,
      [d.userId]
    );
    if (!target.rowCount || !target.rows[0].is_super_admin) return { error: "not_found" };

    // Demoting the last unrestricted admin leaves nobody able to hand the
    // capability back — the recovery is a SQL console on production.
    if (
      target.rows[0].level !== "custom" &&
      d.level === "custom" &&
      (await fullAdminsBesides(c, d.userId)) === 0
    ) {
      return { error: "last_full_admin" };
    }

    await c.query(`update users set admin_permissions = $2 where id = $1`, [
      d.userId,
      JSON.stringify(permissions),
    ]);
    await audit(c, {
      userId: s.user.id,
      action: "admin.team.access",
      entity: "user",
      entityId: d.userId,
      detail: { level: d.level, caps: permissions.caps as Record<string, unknown> },
    });
    revalidatePath("/admin/team");
    return {};
  });
}

/**
 * Takes agency access away.
 *
 * The user row survives, deliberately. They may still be the owner of a clinic,
 * they are referenced by every audit entry they ever wrote, and "no longer works
 * for the agency" is not the same statement as "never existed". Only the flag
 * and the stored permissions go.
 */
export async function revokeAdminAction(userId: string): Promise<TeamResult> {
  const s = await requireAdminCap("admins");
  if (userId === s.user.id) return { error: "self" };

  return withSystem(async (c) => {
    const target = await c.query(
      `select email, is_super_admin from users where id = $1`,
      [userId]
    );
    if (!target.rowCount || !target.rows[0].is_super_admin) return { error: "not_found" };
    if ((await fullAdminsBesides(c, userId)) === 0) return { error: "last_full_admin" };

    await c.query(
      `update users set is_super_admin = false, admin_permissions = '{}'::jsonb where id = $1`,
      [userId]
    );
    /*
      Their sessions go too. A revoked admin holding a live cookie keeps reaching
      /admin until it expires — up to thirty days — and the whole point of
      revoking access is that it stops now. They keep no session anywhere, which
      is correct even if they also run a clinic: signing back in restores that,
      and only that.
    */
    await c.query(`delete from sessions where user_id = $1`, [userId]);

    await audit(c, {
      userId: s.user.id,
      action: "admin.team.revoke",
      entity: "user",
      entityId: userId,
      detail: { email: target.rows[0].email },
    });
    revalidatePath("/admin/team");
    return {};
  });
}

export type { AdminCapability };
