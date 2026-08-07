import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { withSystem } from "./db";

/**
 * Invitation and password-reset tokens.
 *
 * The raw token exists only in the emailed URL. The database stores its SHA-256
 * hash, so a leaked backup cannot be replayed into account takeover. Lookups run
 * in the system context because the visitor is signed out — there is no clinic
 * context to scope by.
 */

const INVITE_TTL_DAYS = 7;
const RESET_TTL_MINUTES = 60;

export type Purpose = "invite" | "reset";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Issues a token and returns the raw value — the only time it is available. */
export async function createAuthToken(
  c: PoolClient,
  opts: { userId: string; clinicId?: string | null; purpose: Purpose; createdBy?: string | null }
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const ttl =
    opts.purpose === "invite"
      ? `${INVITE_TTL_DAYS} days`
      : `${RESET_TTL_MINUTES} minutes`;

  // Supersede any outstanding token of the same kind so an old email stops working.
  await c.query(
    `update auth_tokens set used_at = now()
     where user_id = $1 and purpose = $2 and used_at is null`,
    [opts.userId, opts.purpose]
  );

  await c.query(
    `insert into auth_tokens (user_id, clinic_id, purpose, token_hash, expires_at, created_by)
     values ($1, $2, $3, $4, now() + $5::interval, $6)`,
    [opts.userId, opts.clinicId ?? null, opts.purpose, hashToken(raw), ttl, opts.createdBy ?? null]
  );
  return raw;
}

export type TokenInfo = {
  id: string;
  userId: string;
  clinicId: string | null;
  purpose: Purpose;
  email: string;
  fullName: string;
  clinicName: string | null;
  clinicSlug: string | null;
  locale: "ar" | "en";
};

/** Resolves a raw token, or null when missing, expired or already used. */
export async function readAuthToken(raw: string, purpose: Purpose): Promise<TokenInfo | null> {
  if (!raw || raw.length < 20) return null;
  return withSystem(async (c) => {
    const r = await c.query(
      `select t.id, t.user_id, t.clinic_id, t.purpose, t.token_hash,
              u.email, u.full_name, u.locale,
              cl.name as clinic_name, cl.slug as clinic_slug
       from auth_tokens t
       join users u on u.id = t.user_id
       left join clinics cl on cl.id = t.clinic_id
       where t.token_hash = $1 and t.purpose = $2
         and t.used_at is null and t.expires_at > now()`,
      [hashToken(raw), purpose]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];

    // Constant-time compare so a timing signal can't confirm a partial guess.
    const a = Buffer.from(row.token_hash, "hex");
    const b = Buffer.from(hashToken(raw), "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    return {
      id: row.id,
      userId: row.user_id,
      clinicId: row.clinic_id,
      purpose: row.purpose,
      email: row.email,
      fullName: row.full_name,
      clinicName: row.clinic_name,
      clinicSlug: row.clinic_slug,
      locale: row.locale === "en" ? "en" : "ar",
    };
  });
}

/**
 * Sets the password and burns the token in one transaction, so a double-submit
 * or a replayed link cannot consume it twice.
 */
export async function consumeAuthToken(
  raw: string,
  purpose: Purpose,
  passwordHash: string
): Promise<{ ok: boolean; userId?: string; clinicSlug?: string | null }> {
  return withSystem(async (c) => {
    const r = await c.query(
      `update auth_tokens set used_at = now()
       where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
       returning user_id, clinic_id`,
      [hashToken(raw), purpose]
    );
    if (!r.rowCount) return { ok: false };
    const { user_id, clinic_id } = r.rows[0];

    await c.query(
      `update users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now())
       where id = $1`,
      [user_id, passwordHash]
    );

    // Accepting an invitation activates the membership it was issued for.
    if (clinic_id) {
      await c.query(
        `update clinic_members set active = true where user_id = $1 and clinic_id = $2`,
        [user_id, clinic_id]
      );
    }

    const slug = clinic_id
      ? (await c.query(`select slug from clinics where id = $1`, [clinic_id])).rows[0]?.slug ?? null
      : null;
    return { ok: true, userId: user_id, clinicSlug: slug };
  });
}

/**
 * Recognises this process's own repeat of a submission it already completed.
 *
 * A form that reaches the server twice — React re-invoking an action, an
 * impatient double-click, a client retry after a dropped response — consumes the
 * token on the first pass and fails on the second. Reporting that failure tells
 * somebody their invitation is no longer valid seconds after it worked
 * perfectly, and leaves them staring at a dead end with a working password they
 * do not know they have.
 *
 * This is deliberately narrow. It proves the token was spent moments ago *and*
 * that the caller already knows the resulting password — so it tells an attacker
 * holding a stolen link nothing, because passing it requires the very secret the
 * link would have been used to set.
 */
const REPLAY_WINDOW_SECONDS = 120;

export async function wasJustConsumed(
  raw: string,
  purpose: Purpose,
  password: string,
  verify: (pw: string, hash: string | null) => boolean
): Promise<{ userId: string; clinicSlug: string | null } | null> {
  if (!raw || raw.length < 20) return null;
  return withSystem(async (c) => {
    const r = await c.query(
      `select t.user_id, u.password_hash, cl.slug
         from auth_tokens t
         join users u on u.id = t.user_id
         left join clinics cl on cl.id = t.clinic_id
        where t.token_hash = $1 and t.purpose = $2
          and t.used_at is not null
          and t.used_at > now() - ($3::text || ' seconds')::interval`,
      [hashToken(raw), purpose, String(REPLAY_WINDOW_SECONDS)]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    if (!verify(password, row.password_hash)) return null;
    return { userId: row.user_id as string, clinicSlug: (row.slug as string) ?? null };
  });
}

/** Removes spent and expired rows. Called opportunistically, cheap. */
export async function pruneAuthTokens(c: PoolClient): Promise<void> {
  await c.query(
    `delete from auth_tokens where expires_at < now() - interval '30 days' or used_at < now() - interval '30 days'`
  );
}
