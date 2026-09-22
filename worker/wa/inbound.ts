import {
  downloadMediaMessage,
  normalizeMessageContent,
  proto,
  type WASocket,
  type WAMessage,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { withSystem } from "../db";
import { findPatientByPhone } from "../../src/lib/patients";
import { bareJidUser, isLidJid, jidToE164 } from "../../src/lib/phone";
import { adoptNumber, pnForLid } from "./lid-mapping";
import { saveFile } from "../../src/lib/storage";

const logger = pino({ level: "silent" });

type Extracted = {
  msgType: "text" | "image" | "audio" | "document" | "video" | "sticker" | "location" | "unknown";
  body: string;
  mediaMime?: string;
  mediaName?: string;
  hasMedia: boolean;
};

/**
 * What WhatsApp sends that nobody wrote: reactions, edits and deletions of
 * earlier messages, poll votes, pins, and the key-exchange and context
 * envelopes that ride along with real content. Everything else is something a
 * person sent, and is kept even when it cannot be rendered.
 */
const HOUSEKEEPING = new Set([
  "protocolMessage",
  "reactionMessage",
  "encReactionMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
  "pinInChatMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
]);

/** A shared contact as a line a receptionist can read and dial. */
function contactLine(c: { displayName?: string | null; vcard?: string | null }): string {
  const vcard = c.vcard ?? "";
  const numbers = [...vcard.matchAll(/waid=(\d{7,15})/g)].map((x) => `+${x[1]}`);
  if (!numbers.length) {
    for (const x of vcard.matchAll(/^TEL[^:]*:(.+)$/gm)) numbers.push(x[1].trim());
  }
  return [c.displayName?.trim(), ...new Set(numbers)].filter(Boolean).join(" — ");
}

/**
 * Null when there is nothing a person sent — the message is housekeeping, or
 * it could not be decrypted and has no content at all.
 */
function extract(msg: WAMessage): Extracted | null {
  /*
    Unwrap first. Disappearing messages, view-once media and documents sent
    with a caption all arrive inside an envelope, and reading only the top
    level dropped every one of them — which, for a patient who has
    disappearing messages switched on, was every message they ever sent.
  */
  const m = normalizeMessageContent(msg.message);
  if (!m) return null;
  if (m.conversation) return { msgType: "text", body: m.conversation, hasMedia: false };
  if (m.extendedTextMessage?.text)
    return { msgType: "text", body: m.extendedTextMessage.text, hasMedia: false };
  if (m.imageMessage)
    return {
      msgType: "image",
      body: m.imageMessage.caption ?? "",
      mediaMime: m.imageMessage.mimetype ?? "image/jpeg",
      hasMedia: true,
    };
  if (m.videoMessage)
    return {
      msgType: "video",
      body: m.videoMessage.caption ?? "",
      mediaMime: m.videoMessage.mimetype ?? "video/mp4",
      hasMedia: true,
    };
  if (m.audioMessage)
    return {
      msgType: "audio",
      body: "",
      mediaMime: m.audioMessage.mimetype ?? "audio/ogg",
      hasMedia: true,
    };
  if (m.documentMessage)
    return {
      msgType: "document",
      body: m.documentMessage.caption ?? "",
      mediaMime: m.documentMessage.mimetype ?? "application/octet-stream",
      mediaName: m.documentMessage.fileName ?? "document",
      hasMedia: true,
    };
  // A round video note.
  if (m.ptvMessage)
    return {
      msgType: "video",
      body: "",
      mediaMime: m.ptvMessage.mimetype ?? "video/mp4",
      hasMedia: true,
    };
  if (m.stickerMessage) return { msgType: "sticker", body: "", hasMedia: false };
  const place = m.locationMessage ?? m.liveLocationMessage;
  if (place)
    return {
      msgType: "location",
      body: `${place.degreesLatitude},${place.degreesLongitude}`,
      hasMedia: false,
    };
  // Patients share a relative's or their doctor's number this way.
  if (m.contactMessage)
    return { msgType: "text", body: contactLine(m.contactMessage), hasMedia: false };
  if (m.contactsArrayMessage?.contacts?.length)
    return {
      msgType: "text",
      body: m.contactsArrayMessage.contacts.map(contactLine).join("\n"),
      hasMedia: false,
    };

  /*
    Something a person sent that this cannot render — a poll, an event, a
    product. Keeping it as `unknown` puts "[unknown]" in the thread, which tells
    the receptionist to look at the phone; dropping it told them nothing.
  */
  const content = Object.keys(m).filter(
    (k) => !HOUSEKEEPING.has(k) && (m as Record<string, unknown>)[k] != null
  );
  if (!content.length) return null;
  return { msgType: "unknown", body: "", hasMedia: false };
}

export async function handleUpsert(
  clinicId: string,
  sock: WASocket,
  upsert: BaileysEventMap["messages.upsert"]
) {
  if (upsert.type !== "notify" && upsert.type !== "append") return;
  for (const msg of upsert.messages) {
    try {
      await handleOne(clinicId, sock, msg);
    } catch (e) {
      console.error(`[wa ${clinicId}] message failed`, (e as Error).message);
    }
  }
}

async function handleOne(clinicId: string, sock: WASocket, msg: WAMessage) {
  const jid = msg.key.remoteJid ?? "";
  if (
    !jid ||
    jid.endsWith("@g.us") ||
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter")
  )
    return;

  const fromMe = !!msg.key.fromMe;
  const waId = msg.key.id ?? null;

  if (!msg.message && msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
    /*
      A message that could not be decrypted. Baileys asks the phone to resend
      it and it usually arrives moments later under the same id. Said out loud
      so that a session whose keys have gone bad — every message failing, not
      one — shows up in the logs instead of as a quiet inbox.
    */
    console.warn(
      `[wa ${clinicId}] undecryptable message ${waId} (${msg.messageStubParameters?.[0] ?? "no reason"})`
    );
    return;
  }
  const ex = extract(msg);
  if (!ex) return;

  /*
    WhatsApp addresses many chats by an opaque LID rather than a phone number.
    The digits in one look like a number and are not: matching them out and
    rebuilding <digits>@s.whatsapp.net produces an address nobody is at, and
    the send silently goes nowhere. Keep the LID as a LID, and keep the real
    JID so replies go back to where the message came from.
  */
  const isLid = isLidJid(jid);
  const alt = msg.key.remoteJidAlt ?? null;
  /*
    The other form of the same person, when WhatsApp put it on the message. On
    a message we sent from another device the "sender" is the clinic, so the
    alternate there can be the clinic's own number or LID — never let that
    stand for the patient.
  */
  const own = sock.user?.id ? jidToE164(sock.user.id) : null;
  const altPhone = alt ? jidToE164(alt) : null;
  const lid = isLid
    ? bareJidUser(jid)
    : !fromMe && isLidJid(alt)
      ? bareJidUser(alt!)
      : null;
  /*
    Ask for the number before deciding this is a stranger.

    First from the message itself: WhatsApp sends the sender's number beside
    their LID (`sender_pn`), and Baileys hands it over as `remoteJidAlt`. Then
    from the mapping store, which knows every pairing it has been told. Without
    either, a patient we have on file who moves to identity addressing arrives
    as somebody new, gets a second thread keyed by their LID, and their own
    thread goes quiet — which is what a clinic sees as "WhatsApp put my
    patient's messages somewhere else under a number that isn't theirs".

    A null here is the ordinary case for a genuinely unknown sender;
    `recordMessage` still tries the thread that already holds this LID.
  */
  const phone = isLid
    ? (altPhone && altPhone !== own ? altPhone : null) ?? (await pnForLid(sock, jid))
    : jidToE164(jid);
  // The identifier the conversation is keyed by. For a LID chat we do not know
  // the number yet — the mapping sweep fills it in later, and until then the
  // LID stands in for it.
  const identifier = phone ?? (isLid && lid ? `+${lid}` : null);
  if (!identifier) return;

  let mediaPath: string | null = null;
  if (ex.hasMedia) {
    try {
      const buf = (await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      )) as Buffer;
      const ext = (ex.mediaMime ?? "").split("/")[1]?.split(";")[0] || "bin";
      const name = ex.mediaName || `${ex.msgType}.${ext}`;
      const saved = await saveFile(clinicId, "wa-media", name, buf);
      mediaPath = saved.storagePath;
    } catch (e) {
      console.error(`[wa ${clinicId}] media download failed`, (e as Error).message);
    }
  }

  await recordMessage(clinicId, {
    phone: identifier,
    jid,
    lid,
    dialable: phone !== null,
    fromMe,
    waId,
    msgType: ex.msgType,
    body: ex.body,
    mediaPath,
    mediaMime: ex.mediaMime ?? null,
    mediaName: ex.mediaName ?? null,
    pushName: fromMe ? null : (msg.pushName ?? null),
  });
}

/**
 * Threading core (also used by the dev simulate endpoint): identity rule,
 * conversation upsert, unread counts, inbound trigger.
 */
export async function recordMessage(
  clinicId: string,
  m: {
    /** What the conversation is keyed by — a real number, or a LID standing in. */
    phone: string;
    /** The address WhatsApp used, kept verbatim so replies go back to it. */
    jid?: string | null;
    lid?: string | null;
    /** False when `phone` is really a LID: nothing may dial or match on it. */
    dialable?: boolean;
    fromMe: boolean;
    waId: string | null;
    msgType: string;
    body: string;
    mediaPath: string | null;
    mediaMime: string | null;
    mediaName: string | null;
    pushName: string | null;
  }
) {
  let dialable = m.dialable ?? true;
  let phone = m.phone;
  const lid = m.lid ? bareJidUser(m.lid) : null;
  await withSystem(async (c) => {
    // Dedup (our own sends echo back through messages.upsert)
    if (m.waId) {
      const dup = await c.query(
        `select 1 from messages where clinic_id = $1 and wa_message_id = $2`,
        [clinicId, m.waId]
      );
      if (dup.rowCount) return;
    }

    /*
      No number, but perhaps a thread that already knows this LID.

      When the clinic writes first — a reminder, an invoice — the send resolves
      the patient's number to their LID and stores it on their thread. Their
      reply then comes back from that LID, often with no number on it, and
      keying it by the LID opened a second thread beside the one it was
      answering: the reminder in one, "yes, I'll come" in a stranger's.
    */
    if (!dialable && lid) {
      const known = (
        await c.query(
          `select phone_e164 from conversations
            where clinic_id = $1 and identifier_kind = 'phone'
              and (wa_lid = $2 or wa_lid like $2 || ':%')
            order by last_message_at desc nulls last
            limit 1`,
          [clinicId, lid]
        )
      ).rows[0] as { phone_e164: string } | undefined;
      if (known) {
        phone = known.phone_e164;
        dialable = true;
      }
    }

    /*
      A number and a LID together: if this person already has a thread keyed by
      the LID stand-in, from before the number was known, fold it into the
      number's thread now rather than on the next sweep — otherwise this message
      lands in one thread while the conversation so far sits in another.
    */
    if (dialable && lid) {
      // Tidying, not recording: if the fold fails, the message still lands.
      await c.query("savepoint adopt_number");
      try {
        await adoptNumber(c, clinicId, { lid, phone });
        await c.query("release savepoint adopt_number");
      } catch (e) {
        await c.query("rollback to savepoint adopt_number");
        console.error(`[wa ${clinicId}] lid fold on arrival`, (e as Error).message);
      }
    }

    /*
      Look the sender up, but never create them. A message is not a patient —
      the patient list is for people staff added, the AI booked, or who came
      through the booking link. Anyone else gets a conversation and nothing
      more, and becomes a patient the moment somebody decides they are one.
    */
    // A LID is not a number, so it cannot identify a patient. Only look one up
    // when we actually have something dialable.
    const existing = dialable ? await findPatientByPhone(c, clinicId, phone) : null;
    const patientId = existing?.id ?? null;
    if (patientId && m.pushName) {
      await c.query(
        `update patients set whatsapp_name = coalesce(whatsapp_name, $2) where id = $1`,
        [patientId, m.pushName]
      );
    }

    const conv = await c.query(
      `insert into conversations (clinic_id, phone_e164, patient_id, wa_jid, wa_lid,
                                  identifier_kind, whatsapp_name)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (clinic_id, phone_e164) do update
         set patient_id = coalesce(conversations.patient_id, excluded.patient_id),
             -- Always take the newest address: this is the one that works, and
             -- an older fabricated one is exactly what we are correcting.
             wa_jid = coalesce(excluded.wa_jid, conversations.wa_jid),
             wa_lid = coalesce(excluded.wa_lid, conversations.wa_lid),
             identifier_kind = excluded.identifier_kind,
             -- The thread's own name, so an unknown number is still a person.
             whatsapp_name = coalesce(conversations.whatsapp_name, excluded.whatsapp_name)
       returning id, ai_enabled, ai_paused_until`,
      [
        clinicId,
        phone,
        patientId,
        m.jid ?? `${phone.replace("+", "")}@s.whatsapp.net`,
        lid,
        dialable ? "phone" : "lid",
        m.pushName ?? null,
      ]
    );
    const convId = conv.rows[0].id as string;
    const preview = m.body ? m.body.slice(0, 120) : `[${m.msgType}]`;

    await c.query(
      `insert into messages (clinic_id, conversation_id, direction, sender_kind, wa_message_id,
                             msg_type, body, media_path, media_mime, media_name, status, sent_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        clinicId,
        convId,
        m.fromMe ? "out" : "in",
        m.fromMe ? "staff" : "patient",
        m.waId,
        m.msgType,
        m.body,
        m.mediaPath,
        m.mediaMime,
        m.mediaName,
        m.fromMe ? "sent" : "delivered",
      ]
    );

    await c.query(
      `update conversations set
         last_message_at = now(), last_message_preview = $2, last_message_direction = $3,
         status = 'open',
         unread_count = unread_count + $4
       where id = $1`,
      [convId, preview, m.fromMe ? "out" : "in", m.fromMe ? 0 : 1]
    );

    if (!m.fromMe) {
      await c.query(
        `insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:inbound_message', $2)`,
        [
          clinicId,
          JSON.stringify({
            conversationId: convId,
            // Null when the sender has no file yet; every consumer already
            // treats the patient as optional.
            patientId,
            body: m.body,
            msgType: m.msgType,
          }),
        ]
      );
    }
  });
}
