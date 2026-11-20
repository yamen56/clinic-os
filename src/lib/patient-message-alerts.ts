import type { PoolClient } from "pg";

/*
  The line a patient's WhatsApp conversation puts on the bell (2026-11-20; the
  worker writes it, worker/wa/message-alert.ts). Imported by the worker, so it
  stays inside src/lib and reaches nothing outside it.
*/

/** The key a conversation's line carries; `notifyUser` adds the recipient after a colon. */
export const patientMessageKey = (conversationId: string) => `wa:${conversationId}`;

/**
 * The conversation was read — in the app, or on the clinic's phone — or
 * answered: its line comes off everybody's bell and badge. Read, not deleted,
 * so it is still in the list for whoever looks back.
 *
 * Everybody's only from a system connection (the worker, `withSystem`). Inside
 * a member's own transaction row security narrows it to their own line, which
 * is still right for them; the route that knows the reader has the inbox runs
 * it as the system to clear the rest.
 */
export async function clearPatientMessageAlerts(c: PoolClient, clinicId: string, conversationId: string): Promise<void> {
  await c.query(
    `update notifications set read_at = now()
      where read_at is null
        and dedupe_key = any(select $2 || ':' || cm.user_id::text from clinic_members cm where cm.clinic_id = $1)`,
    [clinicId, patientMessageKey(conversationId)]
  );
}
