"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminCap } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { createAuthToken } from "@/lib/invites";
import { sendEmail, renderEmail } from "@/lib/email";
import { appUrl } from "@/lib/urls";
import { PLANS, type Plan } from "@/lib/plans";
import { BRANCH_PARTS, createBranch } from "@/lib/branches";
import { resolveFeatures } from "@/lib/features";
import { isReservedSlug } from "@/lib/clinic-provision";

/*
  The agency's edits to one clinic from the rebuilt admin (2026-11-27):
  its details, its people, and the plans' starting prices. Every one is
  written in the system context, behind an admin capability, and audited
  against the clinic — the Activity tab reads those rows back.
*/

/* ------------------------------------------------------------ plan prices */

export async function savePlanPricesAction(prices: Record<Plan, number>): Promise<{ error?: string }> {
  const s = await requireAdminCap("clinics.edit");
  await withSystem(async (c) => {
    for (const p of PLANS) {
      const n = Math.max(0, Math.min(100000, Number(prices[p]) || 0));
      await c.query(
        `insert into plan_defaults (plan, price) values ($1, $2)
         on conflict (plan) do update set price = excluded.price, updated_at = now()`,
        [p, n]
      );
    }
    await audit(c, { userId: s.user.id, action: "admin.plan_prices", entity: "plan_defaults", detail: prices });
  });
  revalidatePath("/admin/plans");
  return {};
}

/* -------------------------------------------------------- clinic details */

const detailsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  nameAr: z.string().trim().max(80).default(""),
  phone: z.string().trim().max(40).default(""),
  address: z.string().trim().max(300).default(""),
  addressAr: z.string().trim().max(300).default(""),
  mapsUrl: z.string().trim().max(500).default(""),
  timezone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_]+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  defaultLocale: z.enum(["ar", "en"]),
  dailyCap: z.coerce.number().int().min(10).max(5000),
});

/**
 * The clinic's own details, edited by the agency — what onboarding used to
 * leave to the clinic, or to a support visit. The web address (slug) is not
 * here on purpose: booking and signing links to it are already in patients'
 * WhatsApp.
 */
export async function updateClinicDetailsAction(
  clinicId: string,
  input: unknown
): Promise<{ error?: string; field?: string }> {
  const s = await requireAdminCap("clinics.edit");
  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "") };
  const d = parsed.data;
  const phone = d.phone ? normalizePhone(d.phone) : null;
  if (d.phone && !phone) return { error: "invalid", field: "phone" };
  try {
    new Intl.DateTimeFormat("en", { timeZone: d.timezone });
  } catch {
    return { error: "invalid", field: "timezone" };
  }
  const slug = await withSystem(async (c) => {
    const r = await c.query(
      `update clinics set name = $2, name_ar = nullif($3, ''), phone_e164 = $4, address = nullif($5, ''),
              address_ar = nullif($6, ''), google_maps_url = nullif($7, ''), timezone = $8, currency = $9,
              default_locale = $10, daily_outbound_cap = $11, updated_at = now()
        where id = $1 and deleted_at is null returning slug`,
      [clinicId, d.name, d.nameAr, phone, d.address, d.addressAr, d.mapsUrl, d.timezone, d.currency, d.defaultLocale, d.dailyCap]
    );
    if (!r.rowCount) return null;
    await audit(c, { clinicId, userId: s.user.id, action: "admin.clinic.details", entity: "clinic", entityId: clinicId, detail: d });
    return r.rows[0].slug as string;
  });
  if (!slug) return { error: "not_found" };
  revalidatePath(`/admin/clinics/${slug}`);
  return {};
}

/* ---------------------------------------------------------------- people */

async function memberRow(clinicId: string, memberId: string) {
  return withSystem(async (c) => {
    const r = await c.query(
      `select cm.id, cm.user_id, cm.is_owner, cm.active, u.email, u.full_name, u.locale, u.password_hash is not null as has_password,
              cl.slug, coalesce(nullif(cl.name_ar, ''), cl.name) as clinic_name, cl.default_locale
         from clinic_members cm join users u on u.id = cm.user_id join clinics cl on cl.id = cm.clinic_id
        where cm.id = $1 and cm.clinic_id = $2 and cl.deleted_at is null`,
      [memberId, clinicId]
    );
    return r.rows[0] as
      | {
          id: string;
          user_id: string;
          is_owner: boolean;
          active: boolean;
          email: string;
          full_name: string;
          locale: string;
          has_password: boolean;
          slug: string;
          clinic_name: string;
          default_locale: string;
        }
      | undefined;
  });
}

/**
 * A fresh invitation for anyone who has not accepted theirs, owner or not.
 * Returns the link too, as the owner resend always has: the agency passes it
 * on by WhatsApp when the email went nowhere.
 */
export async function resendMemberInviteAction(
  clinicId: string,
  memberId: string
): Promise<{ error?: string; url?: string; emailed?: boolean }> {
  const s = await requireAdminCap("clinics.edit");
  const m = await memberRow(clinicId, memberId);
  if (!m || !m.active) return { error: "not_found" };
  // A password means a person who signs in; an invitation would be a reset link nobody asked for.
  if (m.has_password) return { error: "already_active" };
  const raw = await withSystem((c) => createAuthToken(c, { userId: m.user_id, clinicId, purpose: "invite", createdBy: s.user.id }));
  const url = `${appUrl()}/invite/${raw}`;
  const sent = await sendEmail({
    to: m.email,
    ...renderEmail({
      type: "invitation",
      locale: m.default_locale === "en" ? "en" : "ar",
      name: m.full_name,
      clinic: m.clinic_name,
      url,
    }),
  });
  await withSystem((c) =>
    audit(c, { clinicId, userId: s.user.id, action: "admin.member.reinvite", entity: "clinic_member", entityId: memberId, detail: { email: m.email } })
  );
  return { url, emailed: sent.ok };
}

/**
 * Hands the clinic to another of its members. The previous owner stays, on
 * full access, because "who owns it" and "who still works there" are two
 * different questions and only the first one is being answered.
 */
export async function transferOwnershipAction(clinicId: string, memberId: string): Promise<{ error?: string }> {
  const s = await requireAdminCap("clinics.edit");
  const m = await memberRow(clinicId, memberId);
  if (!m || !m.active) return { error: "not_found" };
  if (m.is_owner) return {};
  await withSystem(async (c) => {
    await c.query(`update clinic_members set is_owner = false, permissions = '{"level":"full"}' where clinic_id = $1 and is_owner`, [clinicId]);
    await c.query(`update clinic_members set is_owner = true, permissions = '{"level":"full"}' where id = $1`, [memberId]);
    await audit(c, { clinicId, userId: s.user.id, action: "admin.clinic.owner", entity: "clinic_member", entityId: memberId, detail: { email: m.email } });
  });
  revalidatePath(`/admin/clinics/${m.slug}`);
  return {};
}

/**
 * Takes somebody out of a clinic — the person added by mistake, or the one
 * who left while the clinic is over its plan's limit. Their sessions in this
 * clinic end on the next request; what they recorded stays. The owner cannot
 * be removed this way: make someone else the owner first.
 */
export async function removeMemberAction(clinicId: string, memberId: string): Promise<{ error?: string }> {
  const s = await requireAdminCap("clinics.edit");
  const m = await memberRow(clinicId, memberId);
  if (!m) return { error: "not_found" };
  if (m.is_owner) return { error: "owner" };
  await withSystem(async (c) => {
    await c.query(`update clinic_members set active = false where id = $1`, [memberId]);
    await audit(c, { clinicId, userId: s.user.id, action: "admin.member.remove", entity: "clinic_member", entityId: memberId, detail: { email: m.email } });
  });
  revalidatePath(`/admin/clinics/${m.slug}`);
  return {};
}

/* ------------------------------------------------- the new-clinic form */

/**
 * Whether an owner's email already has an account, and where — so the form
 * can say "already uses Clinicti at …" before the clinic is made, instead of
 * the owner wondering why no invitation came.
 */
export async function lookupOwnerAction(
  email: string
): Promise<{ exists: boolean; hasPassword?: boolean; clinics?: string[] }> {
  await requireAdminCap("clinics.create");
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { exists: false };
  return withSystem(async (c) => {
    const u = (await c.query(`select id, password_hash is not null as has_password from users where lower(email) = $1`, [e])).rows[0];
    if (!u) return { exists: false };
    const clinics = (
      await c.query(
        `select coalesce(nullif(cl.name_ar, ''), cl.name) as name from clinic_members cm join clinics cl on cl.id = cm.clinic_id
          where cm.user_id = $1 and cm.active and cl.deleted_at is null order by cm.created_at`,
        [u.id]
      )
    ).rows.map((r) => r.name as string);
    return { exists: true, hasPassword: u.has_password, clinics };
  });
}

/* -------------------------------------------------------------- branches */

const branchSchema = z.object({
  name: z.string().trim().min(2).max(80),
  nameAr: z.string().trim().max(80).default(""),
  slug: z.string().min(2).max(48).regex(/^[a-z0-9][a-z0-9-]*$/),
  phone: z.string().trim().max(40).default(""),
  address: z.string().trim().max(300).default(""),
  addressAr: z.string().trim().max(300).default(""),
  planPrice: z.coerce.number().min(0).max(100000).default(0),
  copy: z.array(z.enum(BRANCH_PARTS)).default([...BRANCH_PARTS]),
  staffUserIds: z.array(z.string().uuid()).max(200).default([]),
});

/**
 * Opens a branch of a clinic: a workspace of its own, in the clinic's group,
 * with what was ticked copied from the main one (lib/branches). Only a clinic
 * whose plan includes branches (Clinic+ and Pro).
 */
export async function addBranchAction(
  mainClinicId: string,
  input: unknown
): Promise<{ error?: string; field?: string; slug?: string }> {
  const s = await requireAdminCap("clinics.create");
  const parsed = branchSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "") };
  const d = parsed.data;
  if (isReservedSlug(d.slug)) return { error: "reserved", field: "slug" };
  const phone = d.phone ? normalizePhone(d.phone) : null;
  if (d.phone && !phone) return { error: "invalid", field: "phone" };
  try {
    const r = await withSystem(async (c) => {
      const main = (await c.query(`select slug, features from clinics where id = $1 and deleted_at is null`, [mainClinicId])).rows[0];
      if (!main) return { error: "not_found" as const };
      if (!resolveFeatures(main.features).branches) return { error: "not_licensed" as const };
      const b = await createBranch(c, {
        mainClinicId,
        name: d.name,
        nameAr: d.nameAr || null,
        slug: d.slug,
        phoneE164: phone,
        address: d.address || null,
        addressAr: d.addressAr || null,
        planPrice: d.planPrice,
        copy: d.copy,
        staffUserIds: d.staffUserIds,
      });
      await audit(c, {
        clinicId: b.clinicId,
        userId: s.user.id,
        action: "admin.clinic.branch",
        entity: "clinic",
        entityId: b.clinicId,
        detail: { of: mainClinicId, slug: b.slug, copy: d.copy, staff: d.staffUserIds.length },
      });
      return { slug: b.slug, mainSlug: main.slug as string };
    });
    if ("error" in r) return { error: r.error };
    revalidatePath("/admin", "layout");
    return { slug: r.slug };
  } catch (e) {
    if ((e as Error).message === "slug_taken") return { error: "taken", field: "slug" };
    console.error("[branch]", e);
    return { error: "generic" };
  }
}
