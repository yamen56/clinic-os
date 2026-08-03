import type { BaileysEventMap } from "@whiskeysockets/baileys";
import { withSystem } from "../db";
import { jidToE164 } from "../../src/lib/phone";
import { findPatientByPhone } from "../../src/lib/patients";

/**
 * Learning the phone number behind a LID.
 *
 * A chat addressed by LID reaches the patient perfectly well, but the number is
 * what ties the thread to a patient file, and it is what a receptionist reads.
 * WhatsApp hands the pairing over eventually — on `chats.phoneNumberShare`, and
 * on contact syncs where a contact carries both forms. This takes it whenever
 * it is offered and upgrades the conversation in place.
 */

export async function learnLidMapping(
  clinicId: string,
  pairs: { lid: string; jid: string }[]
) {
  const clean = pairs
    .map((p) => ({ lid: p.lid?.split("@")[0], phone: jidToE164(p.jid ?? "") }))
    .filter((p): p is { lid: string; phone: string } => !!p.lid && !!p.phone);
  if (!clean.length) return;

  await withSystem(async (c) => {
    for (const { lid, phone } of clean) {
      const conv = (
        await c.query(
          `select id, phone_e164 from conversations
            where clinic_id = $1 and wa_lid = $2 and identifier_kind = 'lid'`,
          [clinicId, lid]
        )
      ).rows[0] as { id: string; phone_e164: string } | undefined;
      if (!conv) continue;

      /*
        The real number may already have a thread of its own — the patient
        wrote from a number once and by LID later. Two threads for one person
        is worse than a thread still labelled by its LID, so leave this one
        alone and let a human merge them.
      */
      const clash = (
        await c.query(
          `select 1 from conversations where clinic_id = $1 and phone_e164 = $2 and id <> $3`,
          [clinicId, phone, conv.id]
        )
      ).rowCount;
      if (clash) {
        console.log(`[wa ${clinicId}] lid ${lid} is ${phone}, which already has a thread`);
        continue;
      }

      const patient = await findPatientByPhone(c, clinicId, phone);
      await c.query(
        `update conversations
            set phone_e164 = $2,
                identifier_kind = 'phone',
                patient_id = coalesce(patient_id, $3),
                -- Unknown again, and now answerable: it is a real number.
                on_whatsapp = null,
                wa_checked_at = null
          where id = $1`,
        [conv.id, phone, patient?.id ?? null]
      );
      console.log(`[wa ${clinicId}] resolved lid ${lid} to ${phone}`);
    }
  });
}

/** Contact syncs carry both forms of the same person often enough to be worth reading. */
export function pairsFromContacts(
  contacts: BaileysEventMap["contacts.upsert"] | BaileysEventMap["contacts.update"]
): { lid: string; jid: string }[] {
  const out: { lid: string; jid: string }[] = [];
  for (const ct of contacts) {
    const lid = ct.lid ?? (ct.id?.endsWith("@lid") ? ct.id : undefined);
    const jid = ct.jid ?? (ct.id?.endsWith("@s.whatsapp.net") ? ct.id : undefined);
    if (lid && jid) out.push({ lid, jid });
  }
  return out;
}
