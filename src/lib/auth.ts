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
import { maskByFeatures, resolveFeatures, type FeatureMap } from "./features";
import {
  resolveAdminCapabilities,
  type AdminCapability,
  type AdminCapabilityMap,
} from "./admin-permissions";

const COOKIE = "cos_session";
const SESSION_DAYS = 30;

/**
 * How long a session may sit unused before it stops working.
 *
 * The absolute thirty days caps how long a stolen cookie can *ever* be worth
 * something. This caps how long an *unattended* one is, which is the shape
 * nearly every real credential theft takes — a lost laptop, a shared machine
 * nobody signed out of, a token copied and kept for later. Thirty days of that
 * is a long time to hold a clinic's patient records.
 *
 * Seven days is chosen against the job rather than against a standard: anybody
 * who uses this product as part of their work touches it within a week, and
 * anybody who does not is barely inconvenienced by signing in again. Shorter
 * would start logging out the part-time doctor who works Saturdays, and a
 * security control that trains people to resent it is one they route around.
 */
const SESSION_IDLE_DAYS = Math.max(1, Number(process.env.SESSION_IDLE_DAYS) || 7);

/**
 * How stale `last_seen_at` may get before a request bothers to refresh it.
 *
 * Writing it on every request would add a row update to every page view and
 * every poll, on the hottest path in the application, to record something that
 * only matters at day resolution. Fifteen minutes makes the write rare enough
 * to be free and still keeps the idle window accurate to well within an hour.
 */
const TOUCH_AFTER_MINUTES = 15;

/**
 * How recently the password must have been given for a dangerous action.
 *
 * Long enough to do the thing you sat down to do — export the list, then export
 * it again in the other format — and short enough that a machine left unlocked
 * over lunch is not still authorised for it.
 */
const REAUTH_WINDOW_MINUTES = Math.max(1, Number(process.env.REAUTH_WINDOW_MINUTES) || 10);

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
  /** The modules the agency licensed to this clinic. See lib/features. */
  features: FeatureMap;
  /** Set once the agency has deleted it; the workspace is closed from then on. */
  deletedAt: string | null;
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
  /**
   * What this person may do in the agency panel. All false for everybody who
   * is not a super admin, so a page can read it without checking the flag first.
   */
  adminCaps: AdminCapabilityMap;
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

/**
 * Being signed in is not always a strong enough claim.
 *
 * A session proves somebody signed in on this device at some point in the last
 * week. For most of the product that is the right question. For "hand me every
 * patient record in this clinic as one file", or "destroy this tenant", it is
 * not: those are the actions where an unlocked laptop, a borrowed machine or a
 * stolen cookie turns into the whole database, and they are rare enough that
 * asking for the password again costs the real user almost nothing.
 *
 * Deliberately a separate query rather than a column on the cached session.
 * This is read on a handful of endpoints; putting it in `getSession` would add
 * it to the hot path of every page render to serve the rarest case.
 */
export async function hasRecentAuth(sessionId: string): Promise<boolean> {
  return withSystem(async (c) => {
    const r = await c.query(
      `select 1 from sessions
        where id = $1 and reauth_at is not null
          and reauth_at > now() - interval '${REAUTH_WINDOW_MINUTES} minutes'`,
      [sessionId]
    );
    return r.rowCount === 1;
  });
}

/** Records that the password was just given again. */
export async function markReauthenticated(sessionId: string): Promise<void> {
  await withSystem((c) =>
    c.query(`update sessions set reauth_at = now() where id = $1`, [sessionId])
  );
}

/**
 * Checks a password against the signed-in user's own hash.
 *
 * Reads the hash fresh rather than trusting anything on the session, and treats
 * an account with no password — an invitation that was never accepted, or a
 * Google-only sign-in — as a refusal. `verifyPassword` already returns false
 * for a null hash; this is where that matters most, because the caller is about
 * to be handed the entire patient list.
 */
export async function passwordMatchesUser(userId: string, password: string): Promise<boolean> {
  if (!password) return false;
  const hash = await withSystem(async (c) => {
    const r = await c.query(`select password_hash from users where id = $1`, [userId]);
    return (r.rows[0]?.password_hash as string | null) ?? null;
  });
  return verifyPassword(password, hash);
}

/** The clinic columns a membership carries, as a json object. Shared with `requireClinic`. */
const CLINIC_JSON = `json_build_object(
  'id', cl.id, 'name', cl.name, 'nameAr', cl.name_ar, 'slug', cl.slug,
  'timezone', cl.timezone, 'currency', cl.currency, 'brandColor', cl.brand_color,
  'logoPath', cl.logo_path, 'defaultLocale', cl.default_locale,
  'subscriptionStatus', cl.subscription_status, 'vocabulary', cl.vocabulary,
  'features', cl.features, 'deletedAt', cl.deleted_at
)`;

type SessionRow = {
  session_id: string;
  impersonated_by: string | null;
  id: string;
  email: string;
  full_name: string;
  phone_e164: string | null;
  is_super_admin: boolean;
  admin_permissions: Record<string, unknown> | null;
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

  /*
    The idle refresh rides along as a data-modifying CTE rather than a second
    query. Postgres runs every part of a statement against the same snapshot, so
    the select below cannot see this update — which is exactly what is wanted:
    the freshness test reads the value as it was on arrival, and the write only
    moves it forward for next time.

    Both conditions on the update matter. `last_seen_at > now() - idle` stops a
    session that has *already* gone stale from being resurrected by the very
    request that should be refused. The `< now() - touch` clause is what keeps
    this from writing a row on every page view.
  */
  const rows = await readOneShot<SessionRow>(
    { isAdmin: true },
    `with touched as (
       update sessions set last_seen_at = now()
        where token_hash = ${th}
          and expires_at > now()
          and last_seen_at > now() - interval '${SESSION_IDLE_DAYS} days'
          and last_seen_at < now() - interval '${TOUCH_AFTER_MINUTES} minutes'
       returning id
     )
     select s.id as session_id, s.impersonated_by,
            u.id, u.email, u.full_name, u.phone_e164, u.is_super_admin, u.admin_permissions,
            u.locale, u.settings,
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
     where s.token_hash = ${th}
       and s.expires_at > now()
       and s.last_seen_at > now() - interval '${SESSION_IDLE_DAYS} days'`
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  return {
    sessionId: row.session_id,
    impersonatedBy: row.impersonated_by,
    adminCaps: resolveAdminCapabilities(row.admin_permissions, {
      isSuperAdmin: row.is_super_admin,
    }),
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phone: row.phone_e164,
      isSuperAdmin: row.is_super_admin,
      locale: row.locale,
      settings: row.settings ?? {},
    },
    memberships: (row.memberships ?? []).map((m) => {
      // The column holds only the exceptions ({} for a clinic with everything),
      // so it is expanded once here and the complete map is what every consumer
      // sees — no screen has to remember that a missing key means "on".
      const features = resolveFeatures(m.clinic.features as unknown as Record<string, unknown>);
      return {
      ...m.clinic,
      features,
      memberId: m.memberId,
      clinicId: m.clinic.id,
      clinicName: m.clinic.name,
      clinicNameAr: m.clinic.nameAr,
      clinicSlug: m.clinic.slug,
      role: m.role,
      isOwner: !!m.isOwner,
      /*
        Two gates, in this order. The member's own permissions resolve first and
        are stored untouched, then the clinic's licence masks whatever it does
        not include — so switching a module off hides it from the owner too, and
        switching it back on returns everybody to exactly the access they had
        rather than to a blank slate somebody has to re-tick.
      */
      caps: maskByFeatures(
        resolveCapabilities(m.permissions, { isOwner: !!m.isOwner, role: m.role }),
        features
      ),
      };
    }),
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
  constructor(public code: "unauthenticated" | "forbidden" | "suspended" | "deleted") {
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

/**
 * A super admin who may do a specific thing in the agency panel.
 *
 * The spelling every admin server action uses, for the same reason `can()`
 * exists on the clinic side: a mutation that only checks `requireSuperAdmin`
 * is a mutation any limited admin can call directly, and the difference between
 * the two calls has to be visible at a glance in review.
 */
export async function requireAdminCap(cap: AdminCapability): Promise<SessionInfo> {
  const s = await requireSuperAdmin();
  if (!s.adminCaps[cap]) throw new AuthError("forbidden");
  return s;
}

export function canAdmin(s: SessionInfo, cap: AdminCapability): boolean {
  return s.adminCaps[cap] === true;
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
    /*
      Deleted stops everybody, the agency included. The rows are still there for
      the length of the restore window, but the workspace is not a place anyone
      works any more — and a support session inside a clinic that is on its way
      to being purged would produce audit entries, messages and documents that
      are about to be destroyed. Restoring it is a button in /admin.
    */
    if (m.deletedAt) throw new AuthError("deleted");
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
    if (clinic.deletedAt) throw new AuthError("deleted");
    const features = resolveFeatures(clinic.features as unknown as Record<string, unknown>);
    return {
      session: s,
      clinicId: clinic.id,
      clinicSlug: slug,
      clinic: { ...clinic, features },
      role: "other",
      isOwner: true,
      memberId: null,
      /*
        Masked like anybody else's. Support mode exists to see what the clinic
        sees; an agency screen showing a module the customer does not have is
        how you end up walking somebody through a page they cannot open. The
        licence is changed from /admin, not from inside the workspace.
      */
      caps: maskByFeatures(allCapabilities(), features),
      isImpersonating: true,
    };
  }
  throw new AuthError("forbidden");
}
