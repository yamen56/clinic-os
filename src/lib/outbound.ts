import type { PoolClient } from "pg";

/**
 * Queues an outbound WhatsApp message. The worker picks up `queued` messages,
 * applies safety rails (delays, caps, windows), and sends via Baileys.
 * Every sender (staff, booking, automations, AI, invoices) goes through here.
 */
export async function queueWhatsAppMessage(
  c: PoolClient,
  opts: {
    clinicId: string;
    phoneE164: string;
    body: string;
    senderKind: "staff" | "automation" | "ai" | "system";
    senderUserId?: string | null;
    automationRunId?: string | null;
    msgType?: "text" | "image" | "document";
    mediaPath?: string | null;
    mediaName?: string | null;
    mediaMime?: string | null;
    scheduledAt?: string | null; // UTC ISO; defaults to now
    patientId?: string | null;
  }
): Promise<{ messageId: string; conversationId: string }> {
  const conv = await c.query(
    `insert into conversations (clinic_id, phone_e164, patient_id)
     values ($1, $2, $3)
     on conflict (clinic_id, phone_e164)
     do update set patient_id = coalesce(conversations.patient_id, excluded.patient_id)
     returning id`,
    [opts.clinicId, opts.phoneE164, opts.patientId ?? null]
  );
  const conversationId = conv.rows[0].id as string;
  const preview = opts.body ? opts.body.slice(0, 120) : `[${opts.msgType ?? "media"}]`;
  const msg = await c.query(
    `insert into messages (clinic_id, conversation_id, direction, sender_kind, sender_user_id,
                           msg_type, body, media_path, media_name, media_mime, status, scheduled_at, automation_run_id)
     values ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, 'queued', coalesce($10::timestamptz, now()), $11)
     returning id`,
    [
      opts.clinicId,
      conversationId,
      opts.senderKind,
      opts.senderUserId ?? null,
      opts.msgType ?? "text",
      opts.body,
      opts.mediaPath ?? null,
      opts.mediaName ?? null,
      opts.mediaMime ?? null,
      opts.scheduledAt ?? null,
      opts.automationRunId ?? null,
    ]
  );
  await c.query(
    `update conversations set last_message_at = now(), last_message_preview = $2, last_message_direction = 'out'
     where id = $1`,
    [conversationId, preview]
  );
  return { messageId: msg.rows[0].id as string, conversationId };
}
