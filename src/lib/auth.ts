import { cookies } from "next/headers";
import { cache } from "react";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { withSystem } from "./db";

const COOKIE = "cos_session";
const SESSION_DAYS = 30;

export type Membership = {
  memberId: string;
  clinicId: string;
  clinicName: string;
  clinicNameAr: string | null;
  clinicSlug: string;
  role: "owner" | "doctor" | "receptionist";
  permissions: Record<string, boolean>;
  subscriptionStatus: string;
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

/** Validates the session cookie. Cached per request. */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const th = hashToken(token);
  return withSystem(async (c) => {
    const r = await c.query(
      `select s.id as session_id, s.impersonated_by,
              u.id, u.email, u.full_name, u.phone_e164, u.is_super_admin, u.locale, u.settings
       from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`,
      [th]
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    const m = await c.query(
      `select cm.id as member_id, cm.clinic_id, cm.role, cm.permissions,
              cl.name, cl.name_ar, cl.slug, cl.subscription_status
       from clinic_members cm join clinics cl on cl.id = cm.clinic_id
       where cm.user_id = $1 and cm.active
       order by cl.name`,
      [row.id]
    );
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
      memberships: m.rows.map((x) => ({
        memberId: x.member_id,
        clinicId: x.clinic_id,
        clinicName: x.name,
        clinicNameAr: x.name_ar,
        clinicSlug: x.slug,
        role: x.role,
        permissions: x.permissions ?? {},
        subscriptionStatus: x.subscription_status,
      })),
    };
  });
});

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
  role: "owner" | "doctor" | "receptionist";
  memberId: string | null;
  permissions: Record<string, boolean>;
  isImpersonating: boolean;
};

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
      role: m.role,
      memberId: m.memberId,
      permissions: m.permissions,
      isImpersonating: !!s.impersonatedBy,
    };
  }
  if (s.user.isSuperAdmin) {
    const clinic = await withSystem(async (c) => {
      const r = await c.query("select id from clinics where slug = $1", [slug]);
      return r.rows[0] ?? null;
    });
    if (!clinic) throw new AuthError("forbidden");
    return {
      session: s,
      clinicId: clinic.id,
      clinicSlug: slug,
      role: "owner",
      memberId: null,
      permissions: {},
      isImpersonating: true,
    };
  }
  throw new AuthError("forbidden");
}
