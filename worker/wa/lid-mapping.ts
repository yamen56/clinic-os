import type { BaileysEventMap } from "@whiskeysockets/baileys";
import type { PoolClient } from "pg";
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

/**
 * The number behind one LID, asked the moment a message arrives.
 *
 * This is the difference between preventing the split and repairing it. Baileys
 * often already knows the pairing when the message lands — it just is not
 * volunteered on the message itself — so asking here means an incoming message
 * from a patient we have on file goes straight onto their existing thread. Ask
 * ten minutes later instead and there are two threads to reconcile, and in
 * between them a receptionist reading a stranger's chat.
 *
 * Every failure is a `null`: an older library with no store, a store that has
 * not learned this pairing, a lookup that throws. All of them mean the same
 * thing to the caller — carry on with the LID, exactly as before.
 */
export async function pnForLid(sock: unknown, lidJid: string): Promise<string | null> {
  const store = (
    sock as {
      signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } };
    }
  ).signalRepository?.lidMapping;
  if (typeof store?.getPNForLID !== "function") return null;
  try {
    const pn = await store.getPNForLID.call(store, lidJid);
    if (!pn) return null;
    // It answers with a JID; tolerate bare digits in case that ever changes.
    return jidToE164(pn) ?? (/^\+?\d{7,15}$/.test(pn) ? `+${pn.replace(/^\+/, "")}` : null);
  } catch {
    return null;
  }
}

/**
 * Folds a LID thread into the thread its real number already had.
 *
 * One person, one conversation. Everything the identity thread accumulated
 * moves across — messages first, because `messages.conversation_id` cascades on
 * delete and a mistake in the order here does not merge a thread, it destroys
 * one. The caller runs inside `withSystem`, which is a transaction, so a
 * failure anywhere rolls the whole fold back rather than leaving half a thread.
 *
 * The surviving row keeps the patient link and the number, and takes the LID
 * thread's *address*: that is the one WhatsApp is currently delivering to, and
 * replacing it with the older phone address is how a reply goes nowhere.
 */
async function mergeThreads(
  c: PoolClient,
  clinicId: string,
  args: { from: string; into: string; lid: string; phone: string }
): Promise<void> {
  const { from, into } = args;

  const moved = await c.query(
    `update messages set conversation_id = $2 where conversation_id = $1`,
    [from, into]
  );
  await c.query(`update automation_runs set conversation_id = $2 where conversation_id = $1`, [
    from,
    into,
  ]);
  /*
    AI state is keyed by conversation, one row each, so the two cannot both
    survive. The thread being kept kept its own; the identity thread's copy is
    scratch — where the agent had got to in a conversation that is about to stop
    existing — and is dropped rather than overwriting it.
  */
  await c.query(`delete from ai_conversation_state where conversation_id = $1`, [from]);

  await c.query(
    `update conversations tgt
        set wa_jid = src.wa_jid,
            wa_lid = coalesce(src.wa_lid, tgt.wa_lid),
            whatsapp_name = coalesce(tgt.whatsapp_name, src.whatsapp_name),
            unread_count = tgt.unread_count + src.unread_count,
            flagged = tgt.flagged or src.flagged,
            flag_reason = coalesce(tgt.flag_reason, src.flag_reason),
            -- Whichever thread was spoken in last is what the inbox should show.
            last_message_at = greatest(
              coalesce(tgt.last_message_at, 'epoch'::timestamptz),
              coalesce(src.last_message_at, 'epoch'::timestamptz)),
            last_message_preview = case
              when coalesce(src.last_message_at, 'epoch'::timestamptz)
                 > coalesce(tgt.last_message_at, 'epoch'::timestamptz)
              then src.last_message_preview else tgt.last_message_preview end,
            last_message_direction = case
              when coalesce(src.last_message_at, 'epoch'::timestamptz)
                 > coalesce(tgt.last_message_at, 'epoch'::timestamptz)
              then src.last_message_direction else tgt.last_message_direction end,
            identifier_kind = 'phone',
            -- Reachability is answerable again now there is a number to ask about.
            on_whatsapp = null,
            wa_checked_at = null
       from conversations src
      where tgt.id = $2 and src.id = $1`,
    [from, into]
  );

  // Only now, with nothing left pointing at it.
  await c.query(`delete from conversations where id = $1 and clinic_id = $2`, [from, clinicId]);

  console.log(
    `[wa ${clinicId}] lid ${args.lid} is ${args.phone} — folded ${moved.rowCount} message(s) into its existing thread`
  );
}

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
        The real number usually already has a thread of its own: the patient
        wrote from a number once, was saved as a file, and WhatsApp moved them
        to identity addressing afterwards. That is the ordinary case, not the
        exotic one.

        This used to log and give up, on the reasoning that a human should merge
        them — but conversations have never been mergeable by hand, so "leave it
        for a human" meant leaving it forever. The patient's own thread went
        quiet while their messages piled up in a second one that showed a
        fifteen-digit stand-in and was attached to nobody.
      */
      const clash = (
        await c.query(
          `select id from conversations where clinic_id = $1 and phone_e164 = $2 and id <> $3`,
          [clinicId, phone, conv.id]
        )
      ).rows[0] as { id: string } | undefined;
      if (clash) {
        await mergeThreads(c, clinicId, { from: conv.id, into: clash.id, lid, phone });
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

/**
 * Give the LID-addressed threads their real numbers.
 *
 * A thread WhatsApp addresses by identity reaches the patient perfectly well,
 * but the number is what ties it to a patient file — and what a receptionist
 * reads, dials, and expects to see when they open the file. Without it a new
 * patient profile shows either a fifteen-digit thing that is not a number or
 * nothing at all.
 *
 * The library can answer this directly, in one batched round trip, so the
 * threads that have been sitting on an identity get resolved rather than
 * waiting for WhatsApp to volunteer the pairing.
 */
export async function resolvePendingLids(clinicId: string, sock: unknown): Promise<number> {
  const resolver = (
    sock as {
      signalRepository?: {
        lidMapping?: { getPNsForLIDs?: (lids: string[]) => Promise<{ pn: string; lid: string }[] | null> };
      };
    }
  ).signalRepository?.lidMapping?.getPNsForLIDs;
  if (typeof resolver !== "function") return 0;

  const pending = await withSystem((c) =>
    c.query(
      `select wa_lid from conversations
        where clinic_id = $1 and identifier_kind = 'lid' and wa_lid is not null
        order by last_message_at desc nulls last
        limit 100`,
      [clinicId]
    )
  );
  if (!pending.rowCount) return 0;

  const lids = pending.rows.map((r) => `${String(r.wa_lid).split("@")[0]}@lid`);
  let pairs: { pn: string; lid: string }[] | null = null;
  try {
    pairs = await resolver.call(
      (sock as { signalRepository: { lidMapping: unknown } }).signalRepository.lidMapping,
      lids
    );
  } catch (e) {
    console.error(`[wa ${clinicId}] lid batch lookup failed`, (e as Error).message);
    return 0;
  }
  if (!pairs?.length) return 0;

  // `learnLidMapping` owns the actual upgrade, including refusing to merge a
  // number that already has a thread of its own.
  const before = pairs.length;
  await learnLidMapping(
    clinicId,
    pairs.filter((p) => p.pn && p.lid).map((p) => ({ lid: p.lid, jid: p.pn }))
  );
  return before;
}

/** Contact syncs carry both forms of the same person often enough to be worth reading. */
export function pairsFromContacts(
  contacts: BaileysEventMap["contacts.upsert"] | BaileysEventMap["contacts.update"]
): { lid: string; jid: string }[] {
  const out: { lid: string; jid: string }[] = [];
  for (const ct of contacts) {
    const lid = ct.lid ?? (ct.id?.endsWith("@lid") ? ct.id : undefined);
    // `phoneNumber` is what the contact's PN form is called now; `id` still
    // holds it on contacts that were never LID-addressed.
    const jid = ct.phoneNumber ?? (ct.id?.endsWith("@s.whatsapp.net") ? ct.id : undefined);
    if (lid && jid) out.push({ lid, jid });
  }
  return out;
}
