import type { PoolClient } from "pg";
import { emitTrigger } from "../triggers";

/**
 * Work a document hands off to the worker.
 *
 * PDF generation launches a browser and can take seconds, so it never happens
 * inside the request that recorded the signature — the patient sees their
 * confirmation screen immediately and the file arrives on WhatsApp a moment
 * later. Everything here is idempotent: a retried job re-renders the same
 * document rather than producing a second one.
 */

export async function enqueueFinalize(
  c: PoolClient,
  clinicId: string,
  documentId: string
): Promise<void> {
  await c.query(
    `insert into jobs (clinic_id, kind, payload, dedupe_key)
     values ($1, 'document:finalize', $2, $3)
     on conflict (dedupe_key) do nothing`,
    [clinicId, JSON.stringify({ documentId }), `document:finalize:${documentId}`]
  );
}

/** Nudges the next signer once the previous one is done. */
export async function enqueueAdvance(
  c: PoolClient,
  clinicId: string,
  documentId: string
): Promise<void> {
  await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'document:advance', $2)`, [
    clinicId,
    JSON.stringify({ documentId }),
  ]);
}

/**
 * Schedules the two reminders the brief ships on by default.
 *
 * Keyed by document and offset so re-sending a link cannot stack duplicates,
 * and cancelled implicitly: the handler re-checks the document's state before
 * sending anything.
 */
export async function scheduleReminders(
  c: PoolClient,
  clinicId: string,
  documentId: string,
  firstAfterHours: number
): Promise<void> {
  const offsets = [Math.max(1, firstAfterHours), Math.max(2, firstAfterHours * 3)];
  for (const hours of offsets) {
    await c.query(
      `insert into jobs (clinic_id, kind, payload, run_at, dedupe_key)
       values ($1, 'document:remind', $2, now() + ($3 * interval '1 hour'), $4)
       on conflict (dedupe_key) do nothing`,
      [
        clinicId,
        JSON.stringify({ documentId, hours }),
        hours,
        `document:remind:${documentId}:${hours}`,
      ]
    );
  }
}

export type DocumentTrigger =
  | "document_sent"
  | "document_viewed"
  | "document_signed"
  | "document_completed"
  | "document_declined"
  | "document_expired";

export async function emitDocumentTrigger(
  c: PoolClient,
  clinicId: string,
  kind: DocumentTrigger,
  payload: { documentId: string; patientId?: string | null; [k: string]: unknown }
): Promise<void> {
  await emitTrigger(
    c,
    clinicId,
    kind as never,
    payload,
    // One firing per document per event kind; a retried job must not restart a
    // reminder flow that already ran.
    `${kind}:${payload.documentId}`
  );
}
