import type { PoolClient } from "pg";

export type TriggerKind =
  | "appointment_created"
  | "appointment_status_changed"
  | "patient_created"
  | "tag_added"
  | "tag_removed"
  | "invoice_sent"
  | "inbound_message"
  | "booking_submitted"
  | "document_sent"
  | "document_viewed"
  | "document_signed"
  | "document_completed"
  | "document_declined"
  | "document_unsigned"
  | "document_expired";

/**
 * Domain events land in the jobs table; the worker's automation engine
 * consumes them. Kept dead-simple so every module can emit without coupling.
 */
export async function emitTrigger(
  c: PoolClient,
  clinicId: string,
  kind: TriggerKind,
  payload: Record<string, unknown>,
  dedupeKey?: string
) {
  await c.query(
    `insert into jobs (clinic_id, kind, payload, dedupe_key)
     values ($1, $2, $3, $4)
     on conflict (dedupe_key) do nothing`,
    [clinicId, `trigger:${kind}`, JSON.stringify(payload), dedupeKey ?? null]
  );
}
