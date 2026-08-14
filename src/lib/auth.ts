import { cookies } from "next/headers";
import { cache } from "react";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { withSystem, readOneShot, safeLiteral } from "./db";
import {
  allCapabilities,
  resolveCapabilities,
  type Capability,
  type CapabilityMap,
  type MemberRole,
} from "./permissions";

const COOKIE = "cos_session";
const SESSION_DAYS = 30;

/**
 * The clinic fields every workspace screen needs. Carried on the session so
 * that resolving access does not cost a second query — the timezone and
 * currency alone were being re-fetched on most pages.
 */
export type ClinicProfile = {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  timezone: string;
  currency: string;
  brandColor: string;
  logoPath: string | null;
  defaultLocale: "ar" | "en";
  subscriptionStatus: string;
  /**
   * Which words this workspace uses for the same objects. "medical" everywhere
   * but Clinicti's own workspace — see migrations/0030 and lib/i18n/vocab.
   */
  vocabulary: "medical" | "agency";
};

export type Membership = ClinicProfile & {
  memberId: string;
  clinicId: string;
  clinicName: string;
  clinicNameAr: string | null;
  clinicSlug: string;
  /** The job, not the access set. See lib/permissions. */
  role: MemberRole;
  isOwner: boolean;
  caps: CapabilityMap;
};

export type SessionInfo = {
  sessionId: string;
  user: {
    id: string;
    email: string;
    fullName: string;
    phone: string | null;
    isSuperAdmin: boolean;
    locale: "ar" | "en";
    settings: Record<string, unknown>;
  };
  impersonatedBy: string | null;
  memberships: Membership[];
};

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

/**
 * A null hash means the account was invited but has not set a password yet.
 * Refuse it explicitly — bcrypt would otherwise throw on a null input, and an
 * unaccepted invitation must never be a way in.
 */
export function verifyPassword(pw: string, hash: string | null): boolean {
  if (!hash) return false;
  return bcrypt.compareSync(pw, hash);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  opts: { impersonatedBy?: string; userAgent?: string } = {}
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await withSystem((c) =>
    c.query(
      `insert into sessions (token_hash, user_id, impersonated_by, expires_at, user_agent)
       values ($1, $2, $3, now() + interval '${SESSION_DAYS} days', $4)`,
      [hashToken(token), userId, opts.impersonatedBy ?? null, opts.userAgent ?? null]
    )
  );
  return token;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86400,
    path: "/",
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(COOKIE);
}

export async function destroySession() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (token) {
    await withSystem((c) => c.query("delete from sessions where token_hash = $1", [hashToken(token)]));
  }
  await clearSessionCookie();
}

/** The clinic columns a membership carries, as a json object. Shared with `requireClinic`. */
const CLINIC_JSON = `json_build_object(
  'id', cl.id, 'name', cl.name, 'nameAr', cl.name_ar, 'slug', cl.slug,
  'timezone', cl.timezone, 'currency', cl.currency, 'brandColor', cl.brand_color,
  'logoPath', cl.logo_path, 'defaultLocale', cl.default_locale,
  'subscriptionStatus', cl.subscription_status, 'vocabulary', cl.vocabulary
)`;

type SessionRow = {
  session_id: string;
  impersonated_by: string | null;
  id: string;
  email: string;
  full_name: string;
  phone_e164: string | null;
  is_super_admin: boolean;
  locale: "ar" | "en";
  settings: Record<string, unknown> | null;
  memberships: {
    memberId: string;
    role: MemberRole;
    isOwner: boolean;
    permissions: Record<string, unknown> | null;
    clinic: ClinicProfile;
  }[];
};

/**
 * Validates the session cookie. Cached per request.
 *
 * This runs before every page render, so it is deliberately one query in one
 * round trip: memberships come back nested rather than as a follow-up select,
 * and `readOneShot` sends the transaction with it. The token hash is a SHA-256
 * digest, which is why it can be inlined.
 */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const th = safeLiteral(hashToken(token));

  const rows = await readOneShot<SessionRow>(
    { isAdmin: true },
    `select s.id as session_id, s.impersonated_by,
            u.id, u.email, u.full_name, u.phone_e164, u.is_super_admin, u.locale, u.settings,
            coalesce((
              select json_agg(json_build_object(
                'memberId', cm.id, 'role', cm.role, 'isOwner', cm.is_owner,
                'permissions', cm.permissions,
                'clinic', ${CLINIC_JSON}
              ) order by cl.name)
              from clinic_members cm join clinics cl on cl.id = cm.clinic_id
              where cm.user_id = u.id and cm.active
            ), '[]'::json) as memberships
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = ${th} and s.expires_at > now()`
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  return {
    sessionId: row.session_id,
    impersonatedBy: row.impersonated_by,
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phone: row.phone_e164,
      isSuperAdmin: row.is_super_admin,
      locale: row.locale,
      settings: row.settings ?? {},
    },
    memberships: (row.memberships ?? []).map((m) => ({
      ...m.clinic,
      memberId: m.memberId,
      clinicId: m.clinic.id,
      clinicName: m.clinic.name,
      clinicNameAr: m.clinic.nameAr,
      clinicSlug: m.clinic.slug,
      role: m.role,
      isOwner: !!m.isOwner,
      caps: resolveCapabilities(m.permissions, { isOwner: !!m.isOwner, role: m.role }),
    })),
  };
});

/**
 * Where a signed-in user belongs. One rule, used by both the login action and
 * `/`, so signing in never bounces through a page that redirects again — a
 * redirect chain out of a Server Action is what made the post-login landing
 * unreliable.
 */
export function landingPathFor(u: { isSuperAdmin: boolean; clinicSlugs: string[] }): string {
  if (u.clinicSlugs.length === 1 && !u.isSuperAdmin) return `/c/${u.clinicSlugs[0]}`;
  if (u.clinicSlugs.length === 0 && u.isSuperAdmin) return "/admin";
  return "/";
}

/**
 * A post-login destination is attacker-controllable (it arrives as `?next=`),
 * so only same-origin absolute paths are honoured. `//host` and `/\host` are
 * protocol-relative URLs, not paths.
 */
export function safeNextPath(next: string | undefined | null): string | null {
  if (!next || !next.startsWith("/")) return null;
  if (next.startsWith("//") || next.startsWith("/\\")) return null;
  if (next === "/login" || next.startsWith("/login/")) return null;
  return next;
}

export class AuthError extends Error {
  constructor(public code: "unauthenticated" | "forbidden" | "suspended") {
    super(code);
  }
}

export async function requireUser(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) throw new AuthError("unauthenticated");
  return s;
}

export async function requireSuperAdmin(): Promise<SessionInfo> {
  const s = await requireUser();
  if (!s.user.isSuperAdmin) throw new AuthError("forbidden");
  return s;
}

export type ClinicAccess = {
  session: SessionInfo;
  clinicId: string;
  clinicSlug: string;
  /** The clinic's own row — already loaded, so pages need not re-select it. */
  clinic: ClinicProfile;
  /** The job title. Gates read `caps`, never this. */
  role: MemberRole;
  isOwner: boolean;
  memberId: string | null;
  caps: CapabilityMap;
  isImpersonating: boolean;
};

/**
 * Whether this access may do something.
 *
 * A function rather than a bare lookup because it is the one spelling every
 * server gate uses — `if (!can(access, "invoices"))` greps as a permission check
 * in a way that `access.caps.invoices` does not.
 */
export function can(access: ClinicAccess, cap: Capability): boolean {
  return access.caps[cap] === true;
}

/** Access check for a clinic workspace. Super admins get owner-level access (impersonation is audited separately). */
export async function requireClinic(slug: string): Promise<ClinicAccess> {
  const s = await requireUser();
  const m = s.memberships.find((x) => x.clinicSlug === slug);
  if (m) {
    if (m.subscriptionStatus === "suspended" && !s.user.isSuperAdmin) throw new AuthError("suspended");
    return {
      session: s,
      clinicId: m.clinicId,
      clinicSlug: slug,
      clinic: m,
      role: m.role,
      isOwner: m.isOwner,
      memberId: m.memberId,
      caps: m.caps,
      isImpersonating: !!s.impersonatedBy,
    };
  }
  if (s.user.isSuperAdmin) {
    // No membership row to read the clinic from, so fetch the same shape here.
    const clinic = await withSystem(async (c) => {
      const r = await c.query(
        `select ${CLINIC_JSON} as clinic from clinics cl where cl.slug = $1`,
        [slug]
      );
      return (r.rows[0]?.clinic ?? null) as ClinicProfile | null;
    });
    if (!clinic) throw new AuthError("forbidden");
    return {
      session: s,
      clinicId: clinic.id,
      clinicSlug: slug,
      clinic,
      role: "other",
      isOwner: true,
      memberId: null,
      caps: allCapabilities(),
      isImpersonating: true,
    };
  }
  throw new AuthError("forbidden");
}
