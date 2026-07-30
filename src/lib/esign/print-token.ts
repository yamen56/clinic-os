import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short-lived key that lets the worker's Chromium open one document's print
 * page without a session.
 *
 * The invoice PDF solved the same problem with the invoice's permanent public
 * token, which is fine for a document the patient is meant to be able to open
 * forever. A signed consent form is not that: nothing about it should be
 * reachable by URL after the render finishes. So the key is derived, not
 * stored — an HMAC over the document id and an expiry, valid for minutes.
 */

const secret = () =>
  process.env.INTERNAL_API_SECRET || "dev-internal-secret-change-in-production";

const TTL_MS = 5 * 60_000;

export type PrintKind = "document" | "certificate" | "overlay";

function sign(documentId: string, kind: PrintKind, exp: number): string {
  return createHmac("sha256", secret()).update(`${documentId}:${kind}:${exp}`).digest("base64url");
}

export function printKey(documentId: string, kind: PrintKind = "document"): { exp: number; sig: string } {
  const exp = Date.now() + TTL_MS;
  return { exp, sig: sign(documentId, kind, exp) };
}

export function printUrl(base: string, documentId: string, kind: PrintKind = "document"): string {
  const { exp, sig } = printKey(documentId, kind);
  return `${base}/doc-print/${documentId}?kind=${kind}&exp=${exp}&sig=${sig}`;
}

export function verifyPrintKey(
  documentId: string,
  kind: string,
  exp: string | undefined,
  sig: string | undefined
): boolean {
  if (!exp || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  if (kind !== "document" && kind !== "certificate" && kind !== "overlay") return false;
  const expected = Buffer.from(sign(documentId, kind, expNum));
  const given = Buffer.from(sig);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
