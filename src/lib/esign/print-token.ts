import { printKeyFor, verifyPrintKeyFor } from "../print-token";

/**
 * The document module's view of the print key.
 *
 * The mechanism moved to `src/lib/print-token.ts` when the patient record
 * needed the same thing — one HMAC shared beats two that drift. This keeps the
 * typed vocabulary the signing code is written against, and keeps `PrintKind`
 * as the allowlist so a key minted for a certificate cannot open an overlay.
 *
 * The signed string is unchanged, so nothing about existing behaviour moved
 * with it.
 */

export type PrintKind = "document" | "certificate" | "overlay";

const KINDS: readonly PrintKind[] = ["document", "certificate", "overlay"];

export function printKey(documentId: string, kind: PrintKind = "document"): { exp: number; sig: string } {
  return printKeyFor(documentId, kind);
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
  return verifyPrintKeyFor(documentId, kind, exp, sig, KINDS);
}
