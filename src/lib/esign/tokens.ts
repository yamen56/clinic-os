import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { appUrl } from "../urls";

/**
 * Signing links.
 *
 * A link is the whole identity check in the default flow, so it is built to be
 * worth exactly one signature and nothing more:
 *
 *  - 32 random bytes, base64url — not guessable, and not derived from any id
 *  - stored as a SHA-256 digest, so a database copy cannot be replayed
 *  - scoped to one signer on one document, never to a patient or a clinic
 *  - single use: signing or declining burns it
 *  - revocable, and revoking takes effect on the next request
 *
 * What makes this sufficient is the delivery channel: the link only ever goes to
 * the patient's own WhatsApp thread, on the number the clinic already has on
 * file. A clinic that wants a code on top of that turns one on per clinic.
 */

const TOKEN_BYTES = 32;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function signingUrl(token: string): string {
  return `${appUrl()}/sign/${token}`;
}

/**
 * Issues a fresh link for a signer and revokes any earlier one.
 *
 * Revoking first is what makes "resend" safe: the message a patient already has
 * stops working the moment a new one is sent, so two live links for the same
 * signature can never exist.
 */
export async function issueSigningToken(
  c: PoolClient,
  args: { clinicId: string; documentId: string; signerId: string; days: number }
): Promise<{ token: string; url: string; expiresAt: string }> {
  await c.query(
    `update signing_tokens set revoked_at = now()
     where signer_id = $1 and revoked_at is null and used_at is null`,
    [args.signerId]
  );

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const days = Math.min(90, Math.max(1, Math.round(args.days || 7)));
  const r = await c.query(
    `insert into signing_tokens (clinic_id, document_id, signer_id, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + ($5 * interval '1 day'))
     returning expires_at`,
    [args.clinicId, args.documentId, args.signerId, hashToken(token), days]
  );
  return { token, url: signingUrl(token), expiresAt: r.rows[0].expires_at };
}

export async function revokeSignerTokens(c: PoolClient, signerId: string): Promise<number> {
  const r = await c.query(
    `update signing_tokens set revoked_at = now()
     where signer_id = $1 and revoked_at is null and used_at is null`,
    [signerId]
  );
  return r.rowCount ?? 0;
}

export type TokenLookup =
  | { ok: true; row: TokenRow }
  | { ok: false; reason: "not_found" | "expired" | "revoked" | "used" | "throttled"; row?: TokenRow };

export type TokenRow = {
  id: string;
  clinic_id: string;
  document_id: string;
  signer_id: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  attempt_count: number;
};

/**
 * Resolves a token to its signer, counting the attempt.
 *
 * The count is kept per token rather than per IP because the interesting abuse
 * is hammering one link, not one visitor opening their own document a few
 * times. A patient who reloads twenty times while their connection drops is
 * normal; two hundred is not a patient.
 */
export async function lookupToken(c: PoolClient, token: string): Promise<TokenLookup> {
  if (!token || token.length < 20 || token.length > 128) return { ok: false, reason: "not_found" };

  const r = await c.query(
    `update signing_tokens set attempt_count = attempt_count + 1
     where token_hash = $1
     returning id, clinic_id, document_id, signer_id, expires_at, used_at, revoked_at, attempt_count`,
    [hashToken(token)]
  );
  const row = r.rows[0] as TokenRow | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.attempt_count > 300) return { ok: false, reason: "throttled", row };
  if (row.revoked_at) return { ok: false, reason: "revoked", row };
  if (row.used_at) return { ok: false, reason: "used", row };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "expired", row };
  return { ok: true, row };
}

/** Burns the link. Called once the signature (or decline) is committed. */
export async function consumeToken(c: PoolClient, tokenId: string): Promise<void> {
  await c.query(`update signing_tokens set used_at = now() where id = $1 and used_at is null`, [
    tokenId,
  ]);
}
