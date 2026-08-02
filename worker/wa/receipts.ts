import type { BaileysEventMap } from "@whiskeysockets/baileys";
import { withSystem } from "../db";

/**
 * Delivery receipts.
 *
 * WhatsApp reports progress out of band, well after `sendMessage` has already
 * returned: one tick when the server took it, two when the handset has it, and
 * blue when it was opened. Without this the inbox can only ever say "we handed
 * it to the socket", which looks identical for a message that arrived and one
 * that went to a number that has no WhatsApp account.
 */

/** Baileys mirrors proto.WebMessageInfo.Status; PLAYED (5) is a voice note read. */
const BY_CODE: Record<number, "sent" | "delivered" | "read"> = {
  2: "sent", // SERVER_ACK
  3: "delivered", // DELIVERY_ACK
  4: "read", // READ
  5: "read", // PLAYED
};

export async function handleReceipts(
  clinicId: string,
  updates: BaileysEventMap["messages.update"]
) {
  const wanted: { waId: string; status: "sent" | "delivered" | "read" }[] = [];
  for (const u of updates) {
    const raw = u.update?.status;
    const code = typeof raw === "number" ? raw : Number(raw);
    const status = BY_CODE[code];
    const waId = u.key?.id;
    if (status && waId && u.key?.fromMe) wanted.push({ waId, status });
  }
  if (!wanted.length) return;

  await withSystem(async (c) => {
    for (const { waId, status } of wanted) {
      /*
        Receipts arrive out of order often enough to matter — a read can land
        before the delivery it implies. Rank the statuses and only ever move
        forward, so a late-arriving 'delivered' cannot un-read a message.
        `array_position` returns null for 'failed' and 'cancelled', which keeps
        a receipt from resurrecting a message we already gave up on.
      */
      await c.query(
        `update messages
            set status = $3,
                delivered_at = case when $3 in ('delivered', 'read')
                                    then coalesce(delivered_at, now()) else delivered_at end,
                read_at = case when $3 = 'read' then coalesce(read_at, now()) else read_at end,
                updated_at = now()
          where clinic_id = $1 and wa_message_id = $2 and direction = 'out'
            and array_position(array['queued','sending','sent','delivered','read'], status)
              < array_position(array['queued','sending','sent','delivered','read'], $3::text)`,
        [clinicId, waId, status]
      );
    }
  });
}
