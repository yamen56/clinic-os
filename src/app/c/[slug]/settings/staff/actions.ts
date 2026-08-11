"use server";

import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";
import { requireClinic, can } from "@/lib/auth";
import { createAuthToken } from "@/lib/invites";
import { sendEmail, renderEmail } from "@/lib/email";
import { appUrl } from "@/lib/urls";
import { inClinic } from "@/lib/clinic-api";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";
import {
  CAPABILITIES,
  capabilitiesFor,
  ROLE_DEFAULTS,
  toAccessSetting,
  type Capability,
} from "@/lib/permissions";

const addStaffSchema = z.object({
  fullName: z.string().min(2).max(80),
  email: z.string().email(),
  role: z.enum(["doctor", "receptionist", "other"]),
  /*
    Access is set here rather than defaulted, because the default that used to
    exist was the job title, and that is exactly the coupling this replaced. A
    new member starts on the sensible set for their job and the owner adjusts
    it — but the owner is the one who decides, on the invitation screen, before
    the account exists.
  */
  access: z.enum(["full", "custom"]).default("custom"),
  caps: z.array(z.enum(CAPABILITIES)).optional(),
  title: z.string().max(60).optional().default(""),
  specialty: z.string().max(60).optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#6989a6"),
});

/**
 * Invites a staff member. No password is set here — the account cannot sign in
 * until the invitee follows the emailed link and chooses one themselves, so an
 * owner never handles a colleague's credentials.
 *
 * When email is not configured the invite link is returned instead, so staff
 * onboarding is never blocked on having a mail provider.
 */
export async function addStaffAction(
  slug: string,
  data: unknown
): Promise<{ error?: string; existing?: boolean; inviteUrl?: string; emailed?: boolean }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.staff")) return { error: "forbidden" };
  const parsed = addStaffSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const permissions = toAccessSetting(
    d.access,
    capabilitiesFor(
      d.caps?.length ? (d.caps as Capability[]) : ROLE_DEFAULTS[d.role]
    )
  );

  /*
    Finding or creating the account runs in the system context: a user is not
    owned by one clinic (the same person can work at two), and the RLS policy on
    `users` deliberately lets a clinic read only its own members. Authorisation
    for this happened above — the caller must be this clinic's owner.
    Membership and audit below stay tenant-scoped.
  */
  const { userId, wasExisting } = await withSystem(async (sc) => {
    const existing = await sc.query(`select id from users where lower(email) = $1`, [
      d.email.toLowerCase(),
    ]);
    if (existing.rowCount) return { userId: existing.rows[0].id as string, wasExisting: true };
    // password_hash stays null until the invitation is accepted.
    const u = await sc.query(
      `insert into users (email, full_name) values ($1, $2) returning id`,
      [d.email, d.fullName]
    );
    return { userId: u.rows[0].id as string, wasExisting: false };
  });

  return inClinic(access, async (c) => {
    const dup = await c.query(
      `select id from clinic_members where clinic_id = $1 and user_id = $2`,
      [access.clinicId, userId]
    );
    if (dup.rowCount) {
      await c.query(
        `update clinic_members set active = true, role = $3, permissions = $4
          where id = $1 and clinic_id = $2`,
        [dup.rows[0].id, access.clinicId, d.role, JSON.stringify(permissions)]
      );
    } else {
      await c.query(
        `insert into clinic_members (clinic_id, user_id, role, title, specialty, color, permissions)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [access.clinicId, userId, d.role, d.title, d.specialty, d.color, JSON.stringify(permissions)]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "staff.add",
      entity: "user",
      entityId: userId,
      detail: { role: d.role, email: d.email },
    });
    // Existing accounts already have a password; only new ones need an invite.
    let inviteUrl: string | undefined;
    let emailed = false;
    if (!wasExisting) {
      const raw = await withSystem((sc) =>
        createAuthToken(sc, {
          userId,
          clinicId: access.clinicId,
          purpose: "invite",
          createdBy: access.session.user.id,
        })
      );
      inviteUrl = `${appUrl()}/invite/${raw}`;
      const clinic = await clinicEmailContext(c, access.clinicId);
      const mail = renderEmail({
        type: "invitation",
        locale: clinic.locale,
        name: d.fullName,
        clinic: clinic.name,
        url: inviteUrl,
      });
      const sent = await sendEmail({ to: d.email, ...mail });
      emailed = sent.ok;
      if (!sent.ok && !sent.skipped) console.error("[invite email]", sent.error);
    }

    revalidatePath(`/c/${slug}/settings/staff`);
    // The link goes back only when it could not be delivered, so the owner can
    // pass it on; on success it is never exposed in the UI.
    return { existing: wasExisting, emailed, inviteUrl: emailed ? undefined : inviteUrl };
  });
}

/** Re-issues an invitation, invalidating any previous link. */
export async function resendInviteAction(
  slug: string,
  memberId: string
): Promise<{ error?: string; inviteUrl?: string; emailed?: boolean }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.staff")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const m = await c.query(
      `select u.id, u.email, u.full_name, u.password_hash
       from clinic_members m join users u on u.id = m.user_id
       where m.id = $1 and m.clinic_id = $2`,
      [memberId, access.clinicId]
    );
    if (!m.rowCount) return { error: "not_found" };
    const u = m.rows[0];
    if (u.password_hash) return { error: "already_active" };

    const raw = await withSystem((sc) =>
      createAuthToken(sc, {
        userId: u.id,
        clinicId: access.clinicId,
        purpose: "invite",
        createdBy: access.session.user.id,
      })
    );
    const inviteUrl = `${appUrl()}/invite/${raw}`;
    const clinic = await clinicEmailContext(c, access.clinicId);
    const sent = await sendEmail({
      to: u.email,
      ...renderEmail({ type: "invitation", locale: clinic.locale, name: u.full_name, clinic: clinic.name, url: inviteUrl }),
    });
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "staff.invite_resent",
      entity: "user",
      entityId: u.id,
      detail: { email: u.email },
    });
    revalidatePath(`/c/${slug}/settings/staff`);
    return { emailed: sent.ok, inviteUrl: sent.ok ? undefined : inviteUrl };
  });
}

/**
 * Display name and language for an invitation. A newly invited person has no
 * stored language preference yet, so the clinic's default decides which of the
 * four templates they receive.
 */
async function clinicEmailContext(
  c: PoolClient,
  clinicId: string
): Promise<{ name: string; locale: "en" | "ar" }> {
  const r = await c.query(
    `select coalesce(name_ar, name) as n, default_locale from clinics where id = $1`,
    [clinicId]
  );
  return {
    name: (r.rows[0]?.n as string) ?? "Clinicti",
    locale: r.rows[0]?.default_locale === "en" ? "en" : "ar",
  };
}

export async function updateMemberAction(
  slug: string,
  memberId: string,
  patch: {
    role?: string;
    title?: string;
    specialty?: string;
    color?: string;
    active?: boolean;
    reminderMinutes?: number;
    access?: { level: "full" | "custom"; caps: string[] };
    workingHours?: Record<string, [string, string][]> | null;
  }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.staff")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const target = (
      await c.query(`select is_owner from clinic_members where id = $1 and clinic_id = $2`, [
        memberId,
        access.clinicId,
      ])
    ).rows[0] as { is_owner: boolean } | undefined;
    if (!target) return { error: "not_found" };

    /*
      Two rules that only exist server-side, because the screen that enforces
      them is not the only way to reach this action.

      An owner's membership is editable only by an owner. `settings.staff` can
      be delegated, and a delegated staff manager who could deactivate the owner
      or strip their access would own the clinic in every way that matters.

      And nobody edits their own role or access. Not because self-promotion is
      the danger — an owner already has everything — but because the mistake it
      prevents is real: a delegated manager quietly removing their own last
      capability, or an owner locking themselves out of the screen they need to
      undo it. Titles, colours and hours are still their own to change.
    */
    if (target.is_owner && !access.isOwner) return { error: "forbidden" };
    const isSelf = memberId === access.memberId;
    if (isSelf && (patch.role !== undefined || patch.access !== undefined || patch.active === false)) {
      return { error: "forbidden_self" };
    }

    const sets: string[] = [];
    const vals: unknown[] = [memberId, access.clinicId];
    const push = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.role && (["doctor", "receptionist", "other"] as string[]).includes(patch.role))
      push("role", patch.role);
    if (patch.title !== undefined) push("title", patch.title.slice(0, 60));
    if (patch.specialty !== undefined) push("specialty", patch.specialty.slice(0, 60));
    if (patch.color && /^#[0-9a-fA-F]{6}$/.test(patch.color)) push("color", patch.color);
    if (patch.active !== undefined) push("active", patch.active);
    if (patch.reminderMinutes !== undefined && patch.reminderMinutes >= 0)
      push("reminder_minutes", Math.min(patch.reminderMinutes, 1440));
    if (patch.access !== undefined) {
      /*
        Rebuilt from the capability list rather than stored as sent. A client
        can put anything in that array; only names this build knows about are
        allowed to become permissions, and the dependency rules are applied
        again here so a section cannot be hidden while its actions stay ticked.
      */
      const caps = capabilitiesFor(
        patch.access.caps.filter((c): c is Capability =>
          (CAPABILITIES as readonly string[]).includes(c)
        )
      );
      push("permissions", JSON.stringify(toAccessSetting(patch.access.level, caps)));
    }
    if (patch.workingHours !== undefined)
      push("working_hours", patch.workingHours ? JSON.stringify(patch.workingHours) : null);
    if (!sets.length) return {};
    const r = await c.query(
      `update clinic_members set ${sets.join(", ")} where id = $1 and clinic_id = $2`,
      vals
    );
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "staff.update",
      entity: "clinic_member",
      entityId: memberId,
      detail: { fields: Object.keys(patch) },
    });
    revalidatePath(`/c/${slug}/settings/staff`);
    return {};
  });
}
