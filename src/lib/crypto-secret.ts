import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Credentials a clinic hands us for somebody else's system, sealed at rest.
 *
 * The JoFotara device secret files tax documents in the clinic's name; the
 * Hakeem Claim credentials will submit insurance claims in it. A database dump
 * — a backup in object storage, a support copy — should not be enough to do
 * either, so these are stored encrypted with a key that lives only in the
 * environment of the web and worker services.
 *
 * AES-256-GCM, so a value that was tampered with fails to open rather than
 * opening to something else. Stored as `enc:v1:` + base64(iv · tag · body); the
 * prefix is what tells a sealed value from one written before this existed, and
 * the version is what will let the scheme change without a flag day.
 *
 * Without `APP_ENCRYPTION_KEY` nothing is sealed and plain values pass through,
 * which is exactly how things were before — so deploying this changes nothing
 * until the key is set on both services. A sealed value with no key to open it
 * is the one hard failure, and it happens in the worker, at send time, where it
 * becomes a failed filing somebody is told about — never at the desk, where it
 * would stop a payment being taken.
 */

const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) return null;
  // Hashed rather than decoded, so any long random string is a valid key.
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Seals a secret for storage. Unchanged when no key is configured. */
export function sealSecret(plain: string): string {
  const k = key();
  if (!k || !plain || isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/**
 * Opens a stored secret. A value from before sealing passes through as it is.
 * Throws when the value is sealed and the key is missing or wrong.
 */
export function openSecret(stored: string): string {
  if (!isSealed(stored)) return stored;
  const k = key();
  if (!k) throw new Error("APP_ENCRYPTION_KEY is not set, so a stored credential cannot be read");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
