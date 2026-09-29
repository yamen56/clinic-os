import type { PoolClient } from "pg";

export type TriggerKind =
  | "appointment_created"
  | "appointment_status_changed"
  | "appointment_rescheduled"
  | "patient_created"
  | "waitlist_booked"
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
  dedupeKey?: string,
  /**
   * Hold the event this long before anything acts on it. For a change people
   * make in bursts — dragging an appointment across the calendar is several
   * saves — paired with a dedupe key, so the burst is acted on once, by
   * whatever it has settled to by then.
   */
  delaySeconds = 0
) {
  await c.query(
    `insert into jobs (clinic_id, kind, payload, dedupe_key, run_at)
     values ($1, $2, $3, $4, now() + ($5::int * interval '1 second'))
     on conflict (dedupe_key) do nothing`,
    [clinicId, `trigger:${kind}`, JSON.stringify(payload), dedupeKey ?? null, delaySeconds]
  );
}
